package embed

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"

	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/types"
)

const (
	maxTitleRunes       = 300
	maxDescriptionRunes = 500
	// Картинку тянем строго быстрее, чем http_server.timeout (4s), иначе
	// Fiber оборвёт запись ответа раньше, чем мы допишем тело.
	imageFetchTimeout = 3 * time.Second
)

var errNotFetchable = errors.New("resource is not fetchable")

// FetchedImage is an image proxied through FetchImage, loaded fully into
// memory (see FetchImage for why).
type FetchedImage struct {
	ContentType string
	Body        []byte
}

// Fetcher performs the outbound HTTP requests that back link previews: the
// page fetch for metadata (Fetch) and the image proxy (FetchImage). Its
// client is hardened against SSRF via a safe dialer (see safedial.go).
type Fetcher struct {
	cfg    config.LinkPreviewConfig
	client *http.Client
}

// NewFetcher builds a Fetcher whose http.Client dials through a safe dialer
// (safedial.go) that re-validates every redirect target, caps redirects at
// cfg.MaxRedirects, disables keep-alives (connections to arbitrary sites
// aren't worth pooling), and pins TLS to max version 1.2 to work around
// TLS 1.3 interception by some local antivirus/firewall software.
func NewFetcher(cfg config.LinkPreviewConfig) *Fetcher {
	dialer := newSafeDialer(cfg.Timeout)

	transport := &http.Transport{
		// http.DefaultTransport делает это по умолчанию, а голый &http.Transport{}
		// нет — без явного Proxy сборка тихо игнорирует HTTP(S)_PROXY/NO_PROXY
		// и любой исходящий фетч за периметром прокси таймаутит и уходит в status=failed.
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   cfg.Timeout,
		ResponseHeaderTimeout: cfg.Timeout,
		// Локальный антивирус/файрвол с HTTPS-инспекцией (Kaspersky и подобные)
		// подменяет TLS-хендшейк и ломает согласование TLS 1.3 ("server did not
		// echo the legacy session ID"). Мы тянем только публичные HTML-страницы
		// ради og:* тегов — понижение до TLS 1.2 здесь не ослабляет ничего
		// чувствительного и снимает эту несовместимость.
		TLSClientConfig: &tls.Config{MaxVersion: tls.VersionTLS12},
		// Соединения к случайным сайтам переиспользовать незачем — держать
		// пул к тысяче доменов дороже, чем передоговориться при повторе.
		DisableKeepAlives: true,
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   cfg.Timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= cfg.MaxRedirects {
				return errors.New("too many redirects")
			}
			// Схему проверяем здесь, IP — в Control диалера при коннекте.
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errBlockedAddress
			}
			return nil
		},
	}

	return &Fetcher{cfg: cfg, client: client}
}

// Fetch downloads the page at normalizedURL and extracts its preview
// metadata. It only returns an error on network failure; a page with no
// OG/Twitter meta tags is a valid result with Status ==
// LinkPreviewStatusEmpty, not an error.
func (f *Fetcher) Fetch(ctx context.Context, normalizedURL string) (types.LinkPreviewRecord, error) {
	pageURL, err := url.Parse(normalizedURL)
	if err != nil {
		return types.LinkPreviewRecord{}, errUnsupportedURL
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, normalizedURL, nil)
	if err != nil {
		return types.LinkPreviewRecord{}, err
	}
	req.Header.Set("User-Agent", f.cfg.UserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9")
	req.Header.Set("Accept-Language", "ru,en;q=0.8")

	resp, err := f.client.Do(req)
	if err != nil {
		return types.LinkPreviewRecord{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return types.LinkPreviewRecord{}, errNotFetchable
	}

	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if !strings.Contains(contentType, "text/html") && !strings.Contains(contentType, "application/xhtml") {
		// Не HTML — качать нечего. Прямые ссылки на файлы (pdf, zip, картинки)
		// сюда попадают штатно и просто остаются без превью.
		return types.LinkPreviewRecord{}, errNotFetchable
	}

	record := parseMetadata(io.LimitReader(resp.Body, f.cfg.MaxBodyBytes), pageURL)
	record.URL = normalizedURL

	return record, nil
}

// FetchImage downloads imageURL for the embed image-proxy endpoint,
// rejecting non-image content and SVG (an executable format, and this is
// served from our own origin). The body is read fully into memory rather
// than streamed: Fiber writes the response only after the handler
// returns, so an unclosed resp.Body can't be handed to it — it would close
// before the write starts.
func (f *Fetcher) FetchImage(ctx context.Context, imageURL string) (FetchedImage, error) {
	ctx, cancel := context.WithTimeout(ctx, imageFetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return FetchedImage{}, err
	}
	req.Header.Set("User-Agent", f.cfg.UserAgent)
	req.Header.Set("Accept", "image/*")

	resp, err := f.client.Do(req)
	if err != nil {
		return FetchedImage{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return FetchedImage{}, errNotFetchable
	}

	contentType := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	if !strings.HasPrefix(contentType, "image/") {
		return FetchedImage{}, errNotFetchable
	}
	// SVG — исполняемый формат, а отдаём мы его уже со своего origin.
	// В <img> скрипты не выполняются, но прямой переход по ссылке — выполнит.
	if contentType == "image/svg+xml" {
		return FetchedImage{}, errNotFetchable
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, f.cfg.MaxImageBytes))
	if err != nil {
		return FetchedImage{}, err
	}
	if len(body) == 0 {
		return FetchedImage{}, errNotFetchable
	}

	return FetchedImage{ContentType: contentType, Body: body}, nil
}

// parseMetadata идёт по токенам до конца <head> и собирает мета-теги.
// Токенизатор x/net/html сам раскодирует HTML-энтити и в тексте, и в значениях
// атрибутов — вручную UnescapeString звать не нужно.
func parseMetadata(reader io.Reader, pageURL *url.URL) types.LinkPreviewRecord {
	tokenizer := html.NewTokenizer(reader)
	meta := make(map[string]string, 16)
	titleTag := ""

	for {
		switch tokenizer.Next() {
		case html.ErrorToken:
			// Сюда же приходит обрыв по лимиту MaxBodyBytes — это не ошибка,
			// а штатный выход: <head> у нормальных страниц помещается в лимит.
			return buildRecord(meta, titleTag, pageURL)

		case html.EndTagToken:
			name, _ := tokenizer.TagName()
			if string(name) == "head" {
				return buildRecord(meta, titleTag, pageURL)
			}

		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := tokenizer.TagName()
			tag := string(name)

			if tag == "body" {
				// Дошли до тела — дальше мета-тегов не будет.
				return buildRecord(meta, titleTag, pageURL)
			}

			if tag == "title" {
				if tokenizer.Next() == html.TextToken {
					titleTag = strings.TrimSpace(string(tokenizer.Text()))
				}
				continue
			}

			if tag != "meta" || !hasAttr {
				continue
			}

			key, content := "", ""
			for {
				rawKey, rawValue, more := tokenizer.TagAttr()
				switch strings.ToLower(string(rawKey)) {
				case "property", "name":
					key = strings.ToLower(strings.TrimSpace(string(rawValue)))
				case "content":
					content = strings.TrimSpace(string(rawValue))
				}
				if !more {
					break
				}
			}

			// Первое вхождение выигрывает: некоторые CMS дублируют og:image
			// десятки раз, и первый из них — обычно основной.
			if key != "" && content != "" {
				if _, exists := meta[key]; !exists {
					meta[key] = content
				}
			}
		}
	}
}

func buildRecord(meta map[string]string, titleTag string, pageURL *url.URL) types.LinkPreviewRecord {
	record := types.LinkPreviewRecord{
		Title:       truncateRunes(firstNonEmpty(meta["og:title"], meta["twitter:title"], titleTag), maxTitleRunes),
		Description: truncateRunes(firstNonEmpty(meta["og:description"], meta["twitter:description"], meta["description"]), maxDescriptionRunes),
		SiteName:    truncateRunes(firstNonEmpty(meta["og:site_name"], meta["application-name"], pageURL.Hostname()), maxTitleRunes),
	}

	rawImage := firstNonEmpty(meta["og:image"], meta["og:image:url"], meta["twitter:image"], meta["twitter:image:src"])
	if rawImage != "" {
		// og:image часто относительный («/og/cover.png») — разворачиваем
		// относительно адреса самой страницы.
		if parsed, err := url.Parse(rawImage); err == nil {
			resolved := pageURL.ResolveReference(parsed)
			if resolved.Scheme == "http" || resolved.Scheme == "https" {
				record.ImageURL = resolved.String()
			}
		}
	}

	// Заголовка нет — показывать нечего: голое описание или один домен
	// выглядят как сломанная карточка.
	if record.Title == "" {
		record.Status = types.LinkPreviewStatusEmpty
		return record
	}

	record.Status = types.LinkPreviewStatusOK
	return record
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return strings.TrimSpace(string(runes[:limit])) + "…"
}
