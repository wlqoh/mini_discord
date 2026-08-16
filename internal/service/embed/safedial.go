package embed

import (
	"errors"
	"net"
	"syscall"
	"time"
)

var errBlockedAddress = errors.New("blocked address")

// Наружу ходим только по стандартным веб-портам: это отсекает попытки
// достучаться до внутренних сервисов (Redis, Postgres, админки) даже если они
// внезапно окажутся на публичном IP.
var allowedPorts = map[string]struct{}{"80": {}, "443": {}}

// isBlockedIP отклоняет всё, что не является публичным маршрутизируемым адресом.
// Ключевой пункт — 169.254.169.254 (метаданные облака), но по той же причине
// закрыты loopback, приватные сети и CGNAT.
func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}

	// To4 сам разворачивает IPv4-mapped адреса вида ::ffff:10.0.0.1,
	// поэтому обойти проверку записью в IPv6-форме не получится.
	if ip4 := ip.To4(); ip4 != nil {
		switch {
		case ip4[0] == 0, // 0.0.0.0/8
			ip4[0] == 10,                                // 10/8
			ip4[0] == 127,                               // loopback
			ip4[0] == 100 && ip4[1]&0xC0 == 64,           // 100.64/10 CGNAT
			ip4[0] == 169 && ip4[1] == 254,               // link-local + метаданные облака
			ip4[0] == 172 && ip4[1]&0xF0 == 16,           // 172.16/12
			ip4[0] == 192 && ip4[1] == 0 && ip4[2] == 0,  // IETF protocol assignments
			ip4[0] == 192 && ip4[1] == 168,               // 192.168/16
			ip4[0] == 198 && ip4[1]&0xFE == 18,           // 198.18/15 benchmarking
			ip4[0] >= 224:                                // multicast, reserved, broadcast
			return true
		}
		return false
	}

	return ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast()
}

// newSafeDialer проверяет адрес в Control — то есть уже после резолва DNS и
// прямо перед подключением к конкретному сокету. Проверять хост заранее
// бессмысленно: DNS-rebinding отдаст публичный IP на проверку и приватный на
// коннект. По той же причине проверка автоматически повторяется на каждом
// редиректе — каждый из них открывает новое соединение.
func newSafeDialer(timeout time.Duration) *net.Dialer {
	return &net.Dialer{
		Timeout: timeout,
		Control: func(network, address string, _ syscall.RawConn) error {
			if network != "tcp4" && network != "tcp6" {
				return errBlockedAddress
			}

			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return errBlockedAddress
			}
			if _, ok := allowedPorts[port]; !ok {
				return errBlockedAddress
			}
			if isBlockedIP(net.ParseIP(host)) {
				return errBlockedAddress
			}

			return nil
		},
	}
}
