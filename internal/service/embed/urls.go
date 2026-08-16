package embed

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

// Максимум URL, которые вообще рассматриваем в одном сообщении. Превью делаем
// только для первого подходящего, но перебрать нужно несколько — первая ссылка
// может вести на наш же домен и быть пропущена.
const maxScannedURLs = 8

var errUnsupportedURL = errors.New("unsupported url")

// Намеренно грубый шаблон: хватаем всё до пробела или угловой скобки, а хвост
// подчищаем отдельно. Точный «правильный» URL-regex здесь только вредит —
// он неизбежно отрежет валидные адреса с кириллицей и скобками.
var urlRegex = regexp.MustCompile(`https?://[^\s<>"']+`)

// ExtractURLs находит ссылки в тексте сообщения в порядке появления.
// Тот же алгоритм продублирован во frontend/src/services/links.ts — их нужно
// править синхронно, иначе фронт подсветит одну ссылку, а превью придёт к другой.
func ExtractURLs(content string) []string {
	matches := urlRegex.FindAllString(content, maxScannedURLs)
	result := make([]string, 0, len(matches))
	for _, match := range matches {
		if trimmed := TrimURLTail(match); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

// TrimURLTail отрезает знаки препинания, прилипшие к ссылке в живом тексте:
// «смотри https://example.com/page.» — точка не часть адреса.
func TrimURLTail(raw string) string {
	// Не называем переменную url — в этом файле так зовётся импортированный пакет.
	trimmed := raw
	for len(trimmed) > 0 && strings.ContainsRune(".,!?;:'\"", rune(trimmed[len(trimmed)-1])) {
		trimmed = trimmed[:len(trimmed)-1]
	}
	// Закрывающая скобка принадлежит ссылке, только если внутри неё же была
	// открывающая: «(см. https://ru.wikipedia.org/wiki/Go_(язык))» — внешнюю
	// скобку съедать нельзя, внутреннюю обязаны сохранить.
	for strings.HasSuffix(trimmed, ")") && strings.Count(trimmed, ")") > strings.Count(trimmed, "(") {
		trimmed = trimmed[:len(trimmed)-1]
	}
	return trimmed
}

// NormalizeURL приводит адрес к каноническому виду для ключа кэша: строчные
// схема и хост, без дефолтного порта и без фрагмента. Query-строку не трогаем —
// в ней живёт смысл (youtube.com/watch?v=…).
func NormalizeURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", errUnsupportedURL
	}

	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errUnsupportedURL
	}
	if parsed.Host == "" {
		return "", errUnsupportedURL
	}

	parsed.Host = strings.ToLower(parsed.Host)
	if (parsed.Scheme == "http" && strings.HasSuffix(parsed.Host, ":80")) ||
		(parsed.Scheme == "https" && strings.HasSuffix(parsed.Host, ":443")) {
		parsed.Host = parsed.Host[:strings.LastIndex(parsed.Host, ":")]
	}

	parsed.Fragment = ""
	parsed.RawFragment = ""

	return parsed.String(), nil
}

// HostsFromURLs — хелпер для сборки списка «своих» хостов из конфига
// (frontend_base_url, S3_HOST, s3.endpoint). Мусор в списке игнорируется.
func HostsFromURLs(rawURLs []string) map[string]struct{} {
	hosts := make(map[string]struct{}, len(rawURLs))
	for _, raw := range rawURLs {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Hostname() == "" {
			continue
		}
		hosts[strings.ToLower(parsed.Hostname())] = struct{}{}
	}
	return hosts
}
