package com.dneprdavid.automonitor;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ServerAddressTest {
    @Test
    public void addsHttpSchemeAndRemovesTrailingSlash() {
        assertEquals("http://192.168.0.106:3001", ServerAddress.normalize(" 192.168.0.106:3001/ "));
    }

    @Test
    public void preservesSecureTailscaleAddress() {
        assertEquals("https://monitor.example.ts.net", ServerAddress.normalize("https://monitor.example.ts.net"));
        assertEquals("https://monitor.example.ts.net", ServerAddress.normalize("monitor.example.ts.net"));
    }

    @Test
    public void rejectsCredentialsAndNonHttpSchemes() {
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("http://user:secret@example.com"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("file:///tmp/index.html"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("http://example.com"));
    }

    @Test
    public void rejectsPathsQueriesAndFragments() {
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("https://example.com/panel"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("https://example.com?token=x"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("https://example.com#x"));
    }

    @Test
    public void comparesOriginsWithDefaultPorts() {
        assertTrue(ServerAddress.isSameOrigin("https://example.com", "https://example.com:443/filters"));
        assertTrue(ServerAddress.isSameOrigin("http://example.com", "http://example.com:80/"));
        assertFalse(ServerAddress.isSameOrigin("https://example.com", "http://example.com/"));
        assertFalse(ServerAddress.isSameOrigin("https://example.com", "https://other.example.com/"));
    }
}
