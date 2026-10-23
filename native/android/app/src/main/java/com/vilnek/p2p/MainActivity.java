package com.vilnek.p2p;

import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

/**
 * P2P Talk main screen.
 *
 * FLAG_SECURE: Android shows this window as black in screenshots, screen recordings, casting
 * to non-secure displays, and in the recent-apps (app switcher) preview.
 *
 * Camera and microphone for the web page: Capacitor's BridgeWebChromeClient.onPermissionRequest
 * asks the user for CAMERA / RECORD_AUDIO (+ MODIFY_AUDIO_SETTINGS) at the moment the page calls
 * getUserMedia, then grants the page's request. Nothing extra is needed here.
 *
 * Screen sharing: ScreenCapturePlugin + ScreenCaptureService (the web side is
 * p2p/src/native/androidScreen.ts). FLAG_SECURE keeps this app's own window black in the capture.
 *
 * Launch screen: the navy splash with the P2P Talk mark stays until the web page has loaded
 * (at most MAX_SPLASH_MS), then fades out in ~200 ms into the web start animation.
 */
public class MainActivity extends BridgeActivity {

    private static final long MAX_SPLASH_MS = 4000;
    private static final long SPLASH_FADE_MS = 200;

    private volatile boolean pageLoaded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        final long start = SystemClock.uptimeMillis();
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        splash.setKeepOnScreenCondition(() -> !pageLoaded && SystemClock.uptimeMillis() - start < MAX_SPLASH_MS);
        splash.setOnExitAnimationListener((provider) -> {
            View view = provider.getView();
            view.animate().alpha(0f).setDuration(SPLASH_FADE_MS).withEndAction(provider::remove).start();
        });

        // Set before the first frame is drawn so nothing is ever captured.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        // Screen sharing in calls (ScreenCapturePlugin); registered before the bridge starts.
        registerPlugin(ScreenCapturePlugin.class);
        // Photos, videos and files sent as originals; Save to Photos / Files, Share (NativeFilesPlugin).
        registerPlugin(NativeFilesPlugin.class);
        super.onCreate(savedInstanceState);

        // TODO(phase 3): Settings > Privacy > "Block screenshots & recording" will be able to turn this off
        // through a small plugin (clearFlags(FLAG_SECURE)). It stays on by default (plan §8.9).

        if (getBridge() != null) {
            getBridge().addWebViewListener(
                new WebViewListener() {
                    @Override
                    public void onPageLoaded(WebView webView) {
                        pageLoaded = true;
                    }
                }
            );
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                WebSettings settings = webView.getSettings();
                // Incoming call audio/video must start without a tap (Capacitor sets this too; kept explicit).
                settings.setMediaPlaybackRequiresUserGesture(false);
            }
        } else {
            pageLoaded = true;
        }
    }
}
