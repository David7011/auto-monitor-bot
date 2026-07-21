package com.dneprdavid.automonitor;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Space;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public final class MainActivity extends Activity {
    private static final String PREFERENCES = "auto_monitor_android";
    private static final String SERVER_URL_KEY = "server_url";
    private static final String CONFIG_VERSION_KEY = "config_version";
    private static final int CONFIG_VERSION = 2;
    private static final int CONNECTION_TIMEOUT_MS = 4_000;
    private static final int READ_TIMEOUT_MS = 4_000;
    // Synced with the dashboard design system (graphite + warm amber).
    private static final int COLOR_BACKGROUND = Color.rgb(9, 10, 13);
    private static final int COLOR_PANEL = Color.rgb(16, 18, 24);
    private static final int COLOR_PANEL_ALT = Color.rgb(22, 25, 34);
    private static final int COLOR_BORDER = Color.rgb(38, 43, 55);
    private static final int COLOR_TEXT = Color.rgb(237, 240, 246);
    private static final int COLOR_MUTED = Color.rgb(134, 143, 161);
    private static final int COLOR_ACCENT = Color.rgb(242, 106, 31);
    private static final int COLOR_SUCCESS = Color.rgb(52, 206, 127);
    private static final int COLOR_DANGER = Color.rgb(242, 89, 74);

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final AtomicInteger connectionGeneration = new AtomicInteger();

    private SharedPreferences preferences;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private FrameLayout browserContainer;
    private LinearLayout offlineView;
    private TextView offlineMessage;
    private TextView connectionStatus;
    private ProgressBar progressBar;
    private WebView webView;
    private String serverUrl;
    private String activeServerUrl;
    private OnBackInvokedCallback backInvokedCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.setStatusBarColor(COLOR_BACKGROUND);
        window.setNavigationBarColor(COLOR_BACKGROUND);

        preferences = getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        serverUrl = loadServerUrl();
        activeServerUrl = serverUrl;
        View root = createRootView();
        setContentView(root);
        configureSystemInsets(root);
        createWebView();
        registerNetworkObserver();
        registerPredictiveBack();
        connect(false);
    }

    private String loadServerUrl() {
        if (preferences.getInt(CONFIG_VERSION_KEY, 0) < CONFIG_VERSION) {
            String migrated = ServerAddress.normalize(BuildConfig.DEFAULT_SERVER_URL);
            preferences.edit()
                .putString(SERVER_URL_KEY, migrated)
                .putInt(CONFIG_VERSION_KEY, CONFIG_VERSION)
                .apply();
            return migrated;
        }

        String saved = preferences.getString(SERVER_URL_KEY, BuildConfig.DEFAULT_SERVER_URL);
        try {
            return ServerAddress.normalize(saved);
        } catch (IllegalArgumentException ignored) {
            return ServerAddress.normalize(BuildConfig.DEFAULT_SERVER_URL);
        }
    }

    private void configureSystemInsets(View root) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;

        Window window = getWindow();
        window.setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((view, windowInsets) -> {
            android.graphics.Insets safeInsets = windowInsets.getInsets(
                WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
            );
            android.graphics.Insets imeInsets = windowInsets.getInsets(WindowInsets.Type.ime());
            view.setPadding(
                safeInsets.left,
                safeInsets.top,
                safeInsets.right,
                Math.max(safeInsets.bottom, imeInsets.bottom)
            );
            return WindowInsets.CONSUMED;
        });
        root.requestApplyInsets();
    }

    private void registerNetworkObserver() {
        connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                mainHandler.post(() -> {
                    if (!isFinishing() && offlineView != null && offlineView.getVisibility() == View.VISIBLE) {
                        connect(false);
                    }
                });
            }
        };
        connectivityManager.registerDefaultNetworkCallback(networkCallback);
    }

    private View createRootView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(COLOR_BACKGROUND);
        root.addView(createToolbar(), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(60)));

        browserContainer = new FrameLayout(this);
        root.addView(browserContainer, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setIndeterminate(true);
        progressBar.setVisibility(View.GONE);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP);
        browserContainer.addView(progressBar, progressParams);

        offlineView = createOfflineView();
        browserContainer.addView(offlineView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return root;
    }

    private View createToolbar() {
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(14), dp(8), dp(8), dp(8));
        toolbar.setBackgroundColor(COLOR_PANEL);

        TextView logo = new TextView(this);
        logo.setText("AM");
        logo.setTextColor(COLOR_ACCENT);
        logo.setTextSize(14);
        logo.setGravity(Gravity.CENTER);
        logo.setTypeface(null, android.graphics.Typeface.BOLD);
        logo.setBackground(roundedBackground(COLOR_PANEL_ALT, COLOR_ACCENT, 9));
        toolbar.addView(logo, new LinearLayout.LayoutParams(dp(42), dp(42)));

        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        titles.setPadding(dp(11), 0, 0, 0);
        TextView title = text("Auto Monitor", 15, COLOR_TEXT, true);
        titles.addView(title);
        connectionStatus = text("Проверка соединения", 11, COLOR_MUTED, false);
        titles.addView(connectionStatus);
        toolbar.addView(titles, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Space spacer = new Space(this);
        toolbar.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1f));

        ImageButton reload = iconButton(R.drawable.ic_refresh, "Обновить панель");
        reload.setOnClickListener(view -> connect(true));
        toolbar.addView(reload, new LinearLayout.LayoutParams(dp(46), dp(46)));

        ImageButton settings = iconButton(R.drawable.ic_settings, "Настроить адрес сервера");
        settings.setOnClickListener(view -> showServerDialog());
        toolbar.addView(settings, new LinearLayout.LayoutParams(dp(46), dp(46)));
        return toolbar;
    }

    private LinearLayout createOfflineView() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setPadding(dp(28), dp(28), dp(28), dp(28));
        layout.setBackgroundColor(COLOR_BACKGROUND);

        TextView icon = text("!", 26, COLOR_DANGER, true);
        icon.setGravity(Gravity.CENTER);
        icon.setBackground(roundedBackground(COLOR_PANEL_ALT, COLOR_DANGER, 14));
        layout.addView(icon, new LinearLayout.LayoutParams(dp(58), dp(58)));

        TextView heading = text("Нет связи с Auto Monitor", 22, COLOR_TEXT, true);
        heading.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        headingParams.setMargins(0, dp(20), 0, dp(8));
        layout.addView(heading, headingParams);

        offlineMessage = text("Проверяю адрес сервера...", 14, COLOR_MUTED, false);
        offlineMessage.setGravity(Gravity.CENTER);
        layout.addView(offlineMessage, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button retry = actionButton("Повторить", COLOR_ACCENT);
        retry.setOnClickListener(view -> connect(true));
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50));
        retryParams.setMargins(0, dp(26), 0, dp(10));
        layout.addView(retry, retryParams);

        Button configure = actionButton("Адрес сервера", COLOR_PANEL_ALT);
        configure.setOnClickListener(view -> showServerDialog());
        layout.addView(configure, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50)));
        return layout;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        if (webView != null) {
            browserContainer.removeView(webView);
            webView.destroy();
        }

        webView = new WebView(this);
        webView.setBackgroundColor(COLOR_BACKGROUND);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " AutoMonitorAndroid/1.2");
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, false);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new DashboardWebViewClient());
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        browserContainer.addView(webView, 0, params);
    }

    private void connect(boolean forceReload) {
        if (!networkAvailable()) {
            showOffline("На телефоне нет активного подключения к сети.");
            return;
        }

        int generation = connectionGeneration.incrementAndGet();
        setConnectionState("Подключение...", COLOR_MUTED);
        progressBar.setVisibility(View.VISIBLE);
        if (!forceReload) offlineView.setVisibility(View.VISIBLE);

        networkExecutor.execute(() -> {
            ConnectionResult result = probeAvailableServer();
            mainHandler.post(() -> {
                if (generation != connectionGeneration.get() || isFinishing()) return;
                if (!result.ok) {
                    showOffline(result.message);
                    return;
                }

                activeServerUrl = result.serverUrl;
                offlineView.setVisibility(View.GONE);
                setConnectionState(connectionLabel(activeServerUrl), COLOR_SUCCESS);
                if (forceReload && ServerAddress.isSameOrigin(activeServerUrl, webView.getUrl())) {
                    webView.reload();
                } else {
                    webView.loadUrl(activeServerUrl);
                }
            });
        });
    }

    private ConnectionResult probeAvailableServer() {
        ProbeResult lastError = ProbeResult.error("Не удалось подключиться ни к одному адресу Auto Monitor.");
        for (String candidate : serverCandidates()) {
            ProbeResult result = probe(candidate);
            if (!result.ok) {
                sleepBeforeRetry();
                result = probe(candidate);
            }
            if (result.ok) return ConnectionResult.ok(candidate);
            lastError = result;
        }
        return ConnectionResult.error(lastError.message);
    }

    private void sleepBeforeRetry() {
        try {
            Thread.sleep(300);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private Set<String> serverCandidates() {
        LinkedHashSet<String> candidates = new LinkedHashSet<>();
        addServerCandidate(candidates, serverUrl);
        addServerCandidate(candidates, BuildConfig.DEFAULT_SERVER_URL);
        addServerCandidate(candidates, BuildConfig.LAN_SERVER_URL);
        return candidates;
    }

    private void addServerCandidate(Set<String> candidates, String value) {
        try {
            candidates.add(ServerAddress.normalize(value));
        } catch (IllegalArgumentException ignored) {
            // Invalid build-time fallback must not make the app unusable.
        }
    }

    private ProbeResult probe(String baseUrl) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(baseUrl + "/login");
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(CONNECTION_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("User-Agent", "AutoMonitorAndroid/1.2");
            connection.setUseCaches(false);
            int status = connection.getResponseCode();
            if (status >= 200 && status < 500) return ProbeResult.ok();
            return ProbeResult.error("Сервер ответил ошибкой HTTP " + status + ".");
        } catch (IOException error) {
            return ProbeResult.error("Не удалось открыть " + baseUrl + ". Убедись, что ноутбук и Auto Monitor включены, а телефон находится в той же сети или Tailscale.");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private boolean networkAvailable() {
        ConnectivityManager manager = connectivityManager != null
            ? connectivityManager
            : (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        Network network = manager.getActiveNetwork();
        if (network == null) return false;
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void showServerDialog() {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(serverUrl);
        input.setSelectAllOnFocus(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setTextColor(COLOR_TEXT);
        input.setHintTextColor(COLOR_MUTED);
        input.setBackground(roundedBackground(COLOR_PANEL_ALT, COLOR_BORDER, 8));
        input.setPadding(dp(12), 0, dp(12), 0);

        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setPadding(dp(20), dp(8), dp(20), 0);
        container.addView(input, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)));

        LinearLayout presets = new LinearLayout(this);
        presets.setOrientation(LinearLayout.HORIZONTAL);
        presets.setPadding(0, dp(10), 0, 0);
        Button remote = actionButton("Из любой точки", COLOR_ACCENT);
        remote.setOnClickListener(view -> input.setText(BuildConfig.DEFAULT_SERVER_URL));
        presets.addView(remote, new LinearLayout.LayoutParams(0, dp(48), 1f));
        Button home = actionButton("Домашняя сеть", COLOR_PANEL_ALT);
        home.setOnClickListener(view -> input.setText(BuildConfig.LAN_SERVER_URL));
        LinearLayout.LayoutParams homeParams = new LinearLayout.LayoutParams(0, dp(48), 1f);
        homeParams.setMargins(dp(8), 0, 0, 0);
        presets.addView(home, homeParams);
        container.addView(presets, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button tailscale = actionButton("Открыть Tailscale", COLOR_PANEL_ALT);
        tailscale.setOnClickListener(view -> openExternal("https://play.google.com/store/apps/details?id=com.tailscale.ipn"));
        LinearLayout.LayoutParams tailscaleParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        tailscaleParams.setMargins(0, dp(8), 0, 0);
        container.addView(tailscale, tailscaleParams);

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle("Адрес Auto Monitor")
            .setMessage("Удалённый адрес работает через приватную сеть Tailscale. Домашний адрес используется как резервный.")
            .setView(container)
            .setNegativeButton("Отмена", null)
            .setNeutralButton("Сбросить вход", (ignored, which) -> clearSession())
            .setPositiveButton("Подключить", null)
            .create();

        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                String normalized = ServerAddress.normalize(input.getText().toString());
                serverUrl = normalized;
                activeServerUrl = normalized;
                preferences.edit()
                    .putString(SERVER_URL_KEY, normalized)
                    .putInt(CONFIG_VERSION_KEY, CONFIG_VERSION)
                    .apply();
                createWebView();
                dialog.dismiss();
                connect(false);
            } catch (IllegalArgumentException error) {
                input.setError(error.getMessage());
            }
        }));
        dialog.show();
    }

    private void clearSession() {
        CookieManager.getInstance().removeAllCookies(value -> {
            CookieManager.getInstance().flush();
            WebView.clearClientCertPreferences(null);
            mainHandler.post(() -> {
                webView.clearCache(true);
                webView.clearHistory();
                Toast.makeText(this, "Сессия входа удалена", Toast.LENGTH_SHORT).show();
                connect(false);
            });
        });
    }

    private void showOffline(String message) {
        progressBar.setVisibility(View.GONE);
        offlineMessage.setText(message + "\n\nТекущий адрес: " + serverUrl);
        offlineView.setVisibility(View.VISIBLE);
        setConnectionState("Нет связи", COLOR_DANGER);
    }

    private String connectionLabel(String url) {
        if (ServerAddress.isSameOrigin(BuildConfig.DEFAULT_SERVER_URL, url)) return "Подключено удалённо";
        if (ServerAddress.isSameOrigin(BuildConfig.LAN_SERVER_URL, url)) return "Подключено дома";
        return "Подключено";
    }

    private void setConnectionState(String text, int color) {
        connectionStatus.setText(text);
        connectionStatus.setTextColor(color);
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "Не найдено приложение для открытия ссылки", Toast.LENGTH_SHORT).show();
        }
    }

    private ImageButton iconButton(int icon, String description) {
        ImageButton button = new ImageButton(this);
        button.setImageResource(icon);
        button.setColorFilter(COLOR_TEXT);
        button.setContentDescription(description);
        button.setBackground(roundedBackground(Color.TRANSPARENT, Color.TRANSPARENT, 8));
        button.setPadding(dp(12), dp(12), dp(12), dp(12));
        return button;
    }

    private Button actionButton(String label, int backgroundColor) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(COLOR_TEXT);
        button.setTextSize(14);
        button.setAllCaps(false);
        button.setTypeface(null, android.graphics.Typeface.BOLD);
        button.setBackground(roundedBackground(backgroundColor, backgroundColor == COLOR_PANEL_ALT ? COLOR_BORDER : backgroundColor, 8));
        return button;
    }

    private TextView text(String value, int sizeSp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sizeSp);
        view.setTextColor(color);
        if (bold) view.setTypeface(null, android.graphics.Typeface.BOLD);
        return view;
    }

    private GradientDrawable roundedBackground(int fillColor, int strokeColor, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fillColor);
        drawable.setCornerRadius(dp(radiusDp));
        if (strokeColor != Color.TRANSPARENT) drawable.setStroke(dp(1), strokeColor);
        return drawable;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @SuppressLint("GestureBackNavigation")
    @SuppressWarnings("deprecation") // Required fallback for Android 8-12; Android 13+ uses OnBackInvokedCallback below.
    @Override
    public void onBackPressed() {
        handleBackNavigation();
    }

    private void registerPredictiveBack() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        backInvokedCallback = this::handleBackNavigation;
        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
            OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            backInvokedCallback
        );
    }

    private void handleBackNavigation() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            finishAfterTransition();
        }
    }

    @Override
    protected void onDestroy() {
        connectionGeneration.incrementAndGet();
        networkExecutor.shutdownNow();
        if (connectivityManager != null && networkCallback != null) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
            } catch (IllegalArgumentException ignored) {
                // The callback may already be detached while Android tears down the process.
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && backInvokedCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backInvokedCallback);
        }
        if (webView != null) {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
        }
        super.onDestroy();
    }

    private final class DashboardWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String target = request.getUrl().toString();
            if (ServerAddress.isSameOrigin(activeServerUrl, target)) return false;
            openExternal(target);
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            progressBar.setVisibility(View.VISIBLE);
            setConnectionState("Загрузка панели...", COLOR_MUTED);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            progressBar.setVisibility(View.GONE);
            offlineView.setVisibility(View.GONE);
            setConnectionState("Подключено", COLOR_SUCCESS);
            CookieManager.getInstance().flush();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                showOffline("Страница панели недоступна: " + error.getDescription());
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
            if (request.isForMainFrame() && errorResponse.getStatusCode() >= 500) {
                showOffline("Dashboard вернул HTTP " + errorResponse.getStatusCode() + ".");
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            showOffline("HTTPS-сертификат сервера не прошел проверку. Небезопасное соединение отменено.");
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            mainHandler.post(() -> {
                createWebView();
                showOffline("Системный компонент Android WebView был перезапущен. Нажми «Повторить».");
            });
            return true;
        }
    }

    private static final class ProbeResult {
        final boolean ok;
        final String message;

        private ProbeResult(boolean ok, String message) {
            this.ok = ok;
            this.message = message;
        }

        static ProbeResult ok() {
            return new ProbeResult(true, "");
        }

        static ProbeResult error(String message) {
            return new ProbeResult(false, message);
        }
    }

    private static final class ConnectionResult {
        final boolean ok;
        final String serverUrl;
        final String message;

        private ConnectionResult(boolean ok, String serverUrl, String message) {
            this.ok = ok;
            this.serverUrl = serverUrl;
            this.message = message;
        }

        static ConnectionResult ok(String serverUrl) {
            return new ConnectionResult(true, serverUrl, "");
        }

        static ConnectionResult error(String message) {
            return new ConnectionResult(false, "", message);
        }
    }
}
