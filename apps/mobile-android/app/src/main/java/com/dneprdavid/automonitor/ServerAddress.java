package com.dneprdavid.automonitor;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

final class ServerAddress {
    private ServerAddress() {}

    static String normalize(String input) {
        String candidate = input == null ? "" : input.trim();
        if (candidate.isEmpty()) {
            throw new IllegalArgumentException("Укажи адрес сервера");
        }
        if (!candidate.contains("://")) {
            candidate = candidate.toLowerCase(Locale.ROOT).contains(".ts.net")
                ? "https://" + candidate
                : "http://" + candidate;
        }

        final URI uri;
        try {
            uri = new URI(candidate);
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Некорректный адрес сервера", error);
        }

        String scheme = lower(uri.getScheme());
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            throw new IllegalArgumentException("Разрешены только http:// и https://");
        }
        if (uri.getHost() == null || uri.getHost().isBlank()) {
            throw new IllegalArgumentException("В адресе отсутствует имя сервера или IP");
        }
        if (uri.getUserInfo() != null) {
            throw new IllegalArgumentException("Логин и пароль нельзя помещать в адрес");
        }
        if ("http".equals(scheme) && !isPrivateNetworkHost(uri.getHost())) {
            throw new IllegalArgumentException("Для внешнего адреса требуется HTTPS");
        }
        String path = uri.getPath();
        if ((path != null && !path.isBlank() && !"/".equals(path)) || uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("Укажи только адрес сервера без пути и параметров");
        }

        try {
            return new URI(scheme, null, uri.getHost(), uri.getPort(), null, null, null).toString();
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Некорректный адрес сервера", error);
        }
    }

    static boolean isSameOrigin(String baseUrl, String targetUrl) {
        try {
            URI base = new URI(baseUrl);
            URI target = new URI(targetUrl);
            return lower(base.getScheme()).equals(lower(target.getScheme()))
                && lower(base.getHost()).equals(lower(target.getHost()))
                && effectivePort(base) == effectivePort(target);
        } catch (URISyntaxException | NullPointerException error) {
            return false;
        }
    }

    private static int effectivePort(URI uri) {
        if (uri.getPort() >= 0) return uri.getPort();
        return "https".equals(lower(uri.getScheme())) ? 443 : 80;
    }

    private static boolean isPrivateNetworkHost(String hostValue) {
        String host = lower(hostValue);
        if ("localhost".equals(host) || "::1".equals(host)) return true;
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        try {
            int first = Integer.parseInt(parts[0]);
            int second = Integer.parseInt(parts[1]);
            for (String part : parts) {
                int octet = Integer.parseInt(part);
                if (octet < 0 || octet > 255) return false;
            }
            return first == 10 || first == 127 || (first == 192 && second == 168)
                || (first == 172 && second >= 16 && second <= 31)
                || (first == 100 && second >= 64 && second <= 127);
        } catch (NumberFormatException error) {
            return false;
        }
    }

    private static String lower(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT);
    }
}
