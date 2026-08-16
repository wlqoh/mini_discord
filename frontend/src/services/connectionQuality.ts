export type QualityLevel = "good" | "medium" | "bad" | "connecting" | "disconnected";

/** Направление, в котором качество хуже. RTT сюда не входит — он симметричен. */
export type QualityDirection = "inbound" | "outbound" | null;

export type QualityMetrics = {
  rttMs: number | null;
  inboundLossPercent: number | null;
  inboundJitterMs: number | null;
  outboundLossPercent: number | null;
  outboundJitterMs: number | null;
};

export type PeerQuality = {
  level: QualityLevel;
  metrics: QualityMetrics;
  direction: QualityDirection;
  /** Для нативного title: статус + цифры. */
  title: string;
  /** Для aria-label: только словесный статус, без телеметрии. */
  ariaLabel: string;
};

export const QUALITY_SAMPLE_INTERVAL_MS = 2000;

export const EMPTY_METRICS: QualityMetrics = {
  rttMs: null,
  inboundLossPercent: null,
  inboundJitterMs: null,
  outboundLossPercent: null,
  outboundJitterMs: null,
};

// Пороги. Значения ориентировочные: калибруются по логам webrtc_debug на реальной
// сети, поэтому вынесены в константы одним блоком.
const RTT_MEDIUM_MS = 200;
const RTT_BAD_MS = 400;
const LOSS_MEDIUM_PERCENT = 2;
const LOSS_BAD_PERCENT = 8;
const JITTER_MEDIUM_MS = 30;
const JITTER_BAD_MS = 80;

// Меньше 20 пакетов за окно — считать процент потерь бессмысленно: одна потеря
// даёт 5% и перекидывает индикатор через порог на ровном месте.
const MIN_PACKETS_FOR_LOSS = 20;

// Сколько подряд лучших замеров нужно, чтобы поднять уровень. Ухудшение
// применяется сразу — «плохо» пользователь должен видеть без задержки.
const RECOVERY_SAMPLES = 2;

const FORCE_LEVEL_KEY = "webrtc_quality_force";

type MeasuredLevel = "good" | "medium" | "bad";

/** Сырая запись из RTCStatsReport: типы в lib.dom нестрогие, читаем через хелперы. */
type RawStat = Record<string, unknown>;

/** Состояние одного пира между замерами: предыдущие счётчики + гистерезис. */
export type QualityTracker = {
  inbound: Map<string, { received: number; lost: number }>;
  remote: Map<string, { lost: number; sent: number }>;
  level: QualityLevel;
  pendingLevel: MeasuredLevel | null;
  pendingCount: number;
};

export function createQualityTracker(): QualityTracker {
  return {
    inbound: new Map(),
    remote: new Map(),
    level: "connecting",
    pendingLevel: null,
    pendingCount: 0,
  };
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** -1 для служебных уровней: они не участвуют в сравнении «кто хуже». */
function rankOf(level: QualityLevel): number {
  if (level === "good") return 0;
  if (level === "medium") return 1;
  if (level === "bad") return 2;
  return -1;
}

function classify(value: number | null, mediumAt: number, badAt: number): MeasuredLevel | null {
  if (value === null) return null;
  if (value >= badAt) return "bad";
  if (value >= mediumAt) return "medium";
  return "good";
}

/** Bottleneck-принцип: итог определяет худшая метрика, а не средняя. */
function worstLevel(...levels: Array<MeasuredLevel | null>): MeasuredLevel | null {
  let result: MeasuredLevel | null = null;
  for (const level of levels) {
    if (!level) continue;
    if (!result || rankOf(level) > rankOf(result)) {
      result = level;
    }
  }
  return result;
}

function worstNumber(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return Math.max(current, candidate);
}

function lossPercent(deltaLost: number, deltaTotal: number): number | null {
  if (deltaTotal < MIN_PACKETS_FOR_LOSS) return null;
  return Math.min(100, Math.max(0, (deltaLost / deltaTotal) * 100));
}

/**
 * RTT берём из выбранной ICE-пары. Идентификатор пары публикует transport, но не во
 * всех браузерах — отсюда двухступенчатый фоллбэк (флаг selected в Firefox,
 * nominated + succeeded в остальных).
 */
function readRoundTripTimeMs(stats: RawStat[]): number | null {
  let selectedPairId: string | null = null;
  for (const stat of stats) {
    if (stat.type === "transport") {
      selectedPairId = str(stat.selectedCandidatePairId) ?? selectedPairId;
    }
  }

  let selected: RawStat | null = null;
  let fallback: RawStat | null = null;

  for (const stat of stats) {
    if (stat.type !== "candidate-pair") continue;

    if (selectedPairId && str(stat.id) === selectedPairId) {
      selected = stat;
      break;
    }
    if (!fallback && (stat.selected === true || (stat.nominated === true && stat.state === "succeeded"))) {
      fallback = stat;
    }
  }

  const pair = selected ?? fallback;
  if (!pair) return null;

  const rttSeconds = num(pair.currentRoundTripTime);
  return rttSeconds === null ? null : rttSeconds * 1000;
}

/**
 * Один замер по одному пиру. Мутирует tracker (перекладывает счётчики),
 * возвращает метрики и измеренный уровень. level === null означает «данных нет»,
 * а не «всё плохо».
 */
export function readQualitySample(
  report: RTCStatsReport,
  tracker: QualityTracker,
): { metrics: QualityMetrics; level: MeasuredLevel | null; direction: QualityDirection } {
  const stats: RawStat[] = [];
  report.forEach((stat) => {
    stats.push(stat as RawStat);
  });

  const metrics: QualityMetrics = { ...EMPTY_METRICS };
  metrics.rttMs = readRoundTripTimeMs(stats);

  // remote-inbound-rtp сообщает только потери; знаменатель приходится брать из
  // связанного с ним outbound-rtp (поле localId).
  const packetsSentById = new Map<string, number>();
  for (const stat of stats) {
    if (stat.type !== "outbound-rtp") continue;
    const id = str(stat.id);
    const sent = num(stat.packetsSent);
    if (id && sent !== null) {
      packetsSentById.set(id, sent);
    }
  }

  const nextInbound = new Map<string, { received: number; lost: number }>();
  const nextRemote = new Map<string, { lost: number; sent: number }>();

  for (const stat of stats) {
    const id = str(stat.id);
    if (!id) continue;

    if (stat.type === "inbound-rtp") {
      const received = num(stat.packetsReceived) ?? 0;
      // packetsLost по спецификации может быть отрицательным (дубликаты пакетов).
      const lost = Math.max(0, num(stat.packetsLost) ?? 0);
      nextInbound.set(id, { received, lost });

      const previous = tracker.inbound.get(id);
      if (previous) {
        const deltaReceived = Math.max(0, received - previous.received);
        const deltaLost = Math.max(0, lost - previous.lost);
        // Худший поток, а не сумма: иначе объём видеопакетов размажет потери аудио.
        metrics.inboundLossPercent = worstNumber(
          metrics.inboundLossPercent,
          lossPercent(deltaLost, deltaLost + deltaReceived),
        );
      }

      const jitterSeconds = num(stat.jitter);
      if (jitterSeconds !== null) {
        metrics.inboundJitterMs = worstNumber(metrics.inboundJitterMs, jitterSeconds * 1000);
      }
      continue;
    }

    if (stat.type === "remote-inbound-rtp") {
      const lost = Math.max(0, num(stat.packetsLost) ?? 0);
      const localId = str(stat.localId);
      const sent = localId ? packetsSentById.get(localId) ?? 0 : 0;
      nextRemote.set(id, { lost, sent });

      const previous = tracker.remote.get(id);
      if (previous) {
        const deltaLost = Math.max(0, lost - previous.lost);
        const deltaSent = Math.max(0, sent - previous.sent);
        const fromDelta = lossPercent(deltaLost, deltaSent);
        // fractionLost — готовая доля из RTCP-отчёта, запасной вариант, когда
        // outbound-rtp не удалось связать со статистикой пира.
        const fromFraction = num(stat.fractionLost);
        metrics.outboundLossPercent = worstNumber(
          metrics.outboundLossPercent,
          fromDelta ?? (fromFraction === null ? null : fromFraction * 100),
        );
      }

      const jitterSeconds = num(stat.jitter);
      if (jitterSeconds !== null) {
        metrics.outboundJitterMs = worstNumber(metrics.outboundJitterMs, jitterSeconds * 1000);
      }

      if (metrics.rttMs === null) {
        const rttSeconds = num(stat.roundTripTime);
        if (rttSeconds !== null) {
          metrics.rttMs = rttSeconds * 1000;
        }
      }
    }
  }

  tracker.inbound = nextInbound;
  tracker.remote = nextRemote;

  const inboundLevel = worstLevel(
    classify(metrics.inboundLossPercent, LOSS_MEDIUM_PERCENT, LOSS_BAD_PERCENT),
    classify(metrics.inboundJitterMs, JITTER_MEDIUM_MS, JITTER_BAD_MS),
  );
  const outboundLevel = worstLevel(
    classify(metrics.outboundLossPercent, LOSS_MEDIUM_PERCENT, LOSS_BAD_PERCENT),
    classify(metrics.outboundJitterMs, JITTER_MEDIUM_MS, JITTER_BAD_MS),
  );
  const rttLevel = classify(metrics.rttMs, RTT_MEDIUM_MS, RTT_BAD_MS);

  return {
    metrics,
    level: worstLevel(inboundLevel, outboundLevel, rttLevel),
    direction: pickDirection(inboundLevel, outboundLevel),
  };
}

function pickDirection(inbound: MeasuredLevel | null, outbound: MeasuredLevel | null): QualityDirection {
  if (inbound && outbound) {
    if (rankOf(inbound) > rankOf(outbound)) return "inbound";
    if (rankOf(outbound) > rankOf(inbound)) return "outbound";
    return null;
  }
  if (inbound && inbound !== "good") return "inbound";
  if (outbound && outbound !== "good") return "outbound";
  return null;
}

/**
 * Гистерезис. Ухудшение — мгновенно, улучшение — после RECOVERY_SAMPLES подряд.
 * Служебные состояния идут мимо: они не измерение, а факт из connectionState.
 */
export function applyHysteresis(tracker: QualityTracker, candidate: QualityLevel): QualityLevel {
  if (candidate === "connecting" || candidate === "disconnected") {
    tracker.level = candidate;
    tracker.pendingLevel = null;
    tracker.pendingCount = 0;
    return candidate;
  }

  const current = tracker.level;
  const measured = candidate as MeasuredLevel;

  // Первый измеренный уровень после подключения показываем сразу: держать
  // «connecting» лишние 4 секунды незачем.
  if (current === "connecting" || current === "disconnected" || rankOf(measured) >= rankOf(current)) {
    tracker.level = measured;
    tracker.pendingLevel = null;
    tracker.pendingCount = 0;
    return measured;
  }

  if (tracker.pendingLevel === measured) {
    tracker.pendingCount += 1;
  } else {
    tracker.pendingLevel = measured;
    tracker.pendingCount = 1;
  }

  if (tracker.pendingCount >= RECOVERY_SAMPLES) {
    tracker.level = measured;
    tracker.pendingLevel = null;
    tracker.pendingCount = 0;
    return measured;
  }

  return current;
}

const PEER_LEVEL_TEXT: Record<QualityLevel, string> = {
  good: "Good connection",
  medium: "Unstable connection",
  bad: "Poor connection",
  connecting: "Connecting…",
  disconnected: "Connection lost",
};

const SELF_LEVEL_TEXT: Record<QualityLevel, string> = {
  good: "Your connection is good",
  medium: "Your connection is unstable",
  bad: "Your connection is poor",
  connecting: "Connecting…",
  disconnected: "Connection lost",
};

export function buildQuality(
  level: QualityLevel,
  metrics: QualityMetrics,
  direction: QualityDirection,
  scope: "peer" | "self" = "peer",
): PeerQuality {
  const headline = scope === "self" ? SELF_LEVEL_TEXT[level] : PEER_LEVEL_TEXT[level];
  const parts = [headline];

  if (metrics.rttMs !== null) {
    parts.push(`ping ${Math.round(metrics.rttMs)} ms`);
  }

  const loss = worstNumber(metrics.inboundLossPercent, metrics.outboundLossPercent);
  if (loss !== null) {
    parts.push(`loss ${loss.toFixed(1)}%`);
  }

  const jitter = worstNumber(metrics.inboundJitterMs, metrics.outboundJitterMs);
  if (jitter !== null) {
    parts.push(`jitter ${Math.round(jitter)} ms`);
  }

  // Сторону называем только когда есть о чём говорить и когда она действительно
  // хуже другой — иначе это дезинформация.
  if (direction && level !== "good" && level !== "connecting") {
    parts.push(direction === "outbound" ? "upload problem" : "download problem");
  }

  return { level, metrics, direction, title: parts.join(" · "), ariaLabel: headline };
}

/** Агрегат «ваше соединение»: худший из линков. */
export function aggregateQuality(items: PeerQuality[]): PeerQuality | null {
  if (!items.length) return null;

  let worst: PeerQuality | null = null;
  let hasConnecting = false;

  for (const item of items) {
    if (item.level === "connecting") {
      hasConnecting = true;
      continue;
    }
    if (item.level === "disconnected") continue;

    if (!worst || rankOf(item.level) > rankOf(worst.level)) {
      worst = item;
    }
  }

  if (worst) {
    return buildQuality(worst.level, worst.metrics, worst.direction, "self");
  }
  if (hasConnecting) {
    return buildQuality("connecting", EMPTY_METRICS, null, "self");
  }
  return buildQuality("disconnected", EMPTY_METRICS, null, "self");
}

function bucket(value: number | null, step: number): string {
  return value === null ? "-" : String(Math.round(value / step));
}

/**
 * Подпись слепка для сравнения «изменилось ли что-нибудь». Метрики огрубляются,
 * иначе дрожание пинга на пару миллисекунд заставляло бы React перерисовывать
 * всю сетку тайлов каждые две секунды.
 */
export function qualitySignature(snapshot: Record<number, PeerQuality>): string {
  return Object.keys(snapshot)
    .map(Number)
    .sort((a, b) => a - b)
    .map((userID) => {
      const item = snapshot[userID];
      const loss = worstNumber(item.metrics.inboundLossPercent, item.metrics.outboundLossPercent);
      const jitter = worstNumber(item.metrics.inboundJitterMs, item.metrics.outboundJitterMs);
      return [
        userID,
        item.level,
        bucket(item.metrics.rttMs, 25),
        bucket(loss, 0.5),
        bucket(jitter, 5),
        item.direction ?? "-",
      ].join(":");
    })
    .join("|");
}

/**
 * Dev-оверрайд: localStorage.webrtc_quality_force = "bad" рисует нужное состояние
 * на всех тайлах. Единственный практичный способ увидеть вёрстку `medium`.
 */
export function readForcedLevel(): QualityLevel | null {
  try {
    const raw = window.localStorage.getItem(FORCE_LEVEL_KEY);
    if (raw === "good" || raw === "medium" || raw === "bad" || raw === "connecting" || raw === "disconnected") {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}
