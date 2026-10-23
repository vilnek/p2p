package com.vilnek.p2p;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * "ScreenCapture": screen sharing for the web app (Android's WebView has no getDisplayMedia).
 * The web side is p2p/src/native/androidScreen.ts.
 *
 *   start({ maxWidth, maxHeight, fps, audio, binary }) -> { width, height, channels }
 *       asks Android for consent every time (Android 14+ consent works once), then the
 *       ScreenCaptureService captures. Cancelled: rejected with code "cancelled".
 *   stop()
 *   event "stopped" { reason }: Stop in the notification ("user"), Android ended it ("ended"),
 *       the app was closed ("closed"), or stop() ("app").
 *   frames: JPEG bytes. Fast path: binary (ArrayBuffer) through the page's injected "P2PScreen"
 *       object (only on this app's own page). Fallback: event "frame" { data: base64 }.
 *   sound (audio: true, Android 10+; channels 0 means none): 20 ms of 48 kHz 16-bit PCM.
 *       Binary: "PCM" + a channel-count byte, then the samples. Fallback: event "audio" { data: base64 }.
 */
@CapacitorPlugin(
    name = "ScreenCapture",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class ScreenCapturePlugin extends Plugin implements ScreenCaptureService.Listener {

    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicReference<byte[]> latest = new AtomicReference<>();
    private final AtomicBoolean delivering = new AtomicBoolean(false);
    private boolean binarySupported;
    private JavaScriptReplyProxy reply; // the page's P2PScreen object (main thread)
    private boolean binary;
    private volatile PluginCall pendingStart;
    private volatile int audioChannels;

    @Override
    public void load() {
        ScreenCaptureService.setListener(this);
        WebView webView = getBridge().getWebView();
        binarySupported =
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER);
        if (!binarySupported || webView == null) return;
        try {
            // Only the app's own page (https://localhost) gets the object, main frame only.
            Uri local = Uri.parse(getBridge().getLocalUrl());
            String origin = local.getScheme() + "://" + local.getAuthority();
            WebViewCompat.addWebMessageListener(
                webView,
                "P2PScreen",
                Collections.singleton(origin),
                (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                    if (isMainFrame) reply = replyProxy; // the page says hello before start()
                }
            );
        } catch (RuntimeException e) {
            binarySupported = false;
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (pendingStart != null) {
            call.reject("Screen sharing is already starting.", "busy");
            return;
        }
        // One share at a time: a new start ends the old one.
        main.post(() -> ScreenCaptureService.stopNow("app"));
        // Android 13+: the notification (with its Stop button) needs this permission. Sharing works without it.
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsAnswered");
            return;
        }
        askConsent(call);
    }

    @PermissionCallback
    private void notificationsAnswered(PluginCall call) {
        askConsent(call);
    }

    private void askConsent(PluginCall call) {
        MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            call.reject("This phone can't share its screen.", "unavailable");
            return;
        }
        startActivityForResult(call, mpm.createScreenCaptureIntent(), "consentAnswered");
    }

    @ActivityCallback
    private void consentAnswered(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.reject("Screen sharing was cancelled.", "cancelled");
            return;
        }
        binary = binarySupported && Boolean.TRUE.equals(call.getBoolean("binary", false));
        pendingStart = call;
        Intent start = new Intent(getContext(), ScreenCaptureService.class)
            .setAction(ScreenCaptureService.ACTION_START)
            .putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.getResultCode())
            .putExtra(ScreenCaptureService.EXTRA_DATA, data)
            .putExtra(ScreenCaptureService.EXTRA_MAX_WIDTH, clamp(call.getInt("maxWidth", 1280), 160, 1920))
            .putExtra(ScreenCaptureService.EXTRA_MAX_HEIGHT, clamp(call.getInt("maxHeight", 1280), 160, 1920))
            .putExtra(ScreenCaptureService.EXTRA_FPS, clamp(call.getInt("fps", 10), 1, 30))
            .putExtra(ScreenCaptureService.EXTRA_AUDIO, Boolean.TRUE.equals(call.getBoolean("audio", false)));
        try {
            ContextCompat.startForegroundService(getContext(), start);
        } catch (RuntimeException e) {
            pendingStart = null;
            call.reject("Screen sharing could not start.", "failed");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            ScreenCaptureService.stopNow("app");
            call.resolve();
        });
    }

    // ---- from the service --------------------------------------------------------------------

    @Override
    public void onStarted(int width, int height, int channels) {
        audioChannels = channels;
        PluginCall call = pendingStart;
        pendingStart = null;
        if (call == null) return;
        JSObject ret = new JSObject();
        ret.put("width", width);
        ret.put("height", height);
        ret.put("channels", channels);
        ret.put("binary", binary);
        call.resolve(ret);
    }

    @Override
    public void onFailed(String message) {
        PluginCall call = pendingStart;
        pendingStart = null;
        if (call != null) call.reject(message, "failed");
    }

    @Override
    public void onStopped(String reason) {
        latest.set(null);
        JSObject ret = new JSObject();
        ret.put("reason", reason);
        notifyListeners("stopped", ret);
    }

    /** Capture thread. Only the newest frame waits; the page never gets a backlog. */
    @Override
    public void onFrame(byte[] jpeg) {
        latest.set(jpeg);
        if (delivering.compareAndSet(false, true)) main.post(deliver);
    }

    private final Runnable deliver = () -> {
        delivering.set(false);
        byte[] jpeg = latest.getAndSet(null);
        if (jpeg == null || !ScreenCaptureService.isRunning()) return;
        if (binary && reply != null) {
            try {
                reply.postMessage(jpeg); // an ArrayBuffer on the page, no copying to text
                return;
            } catch (RuntimeException e) {
                binary = false;
            }
        }
        JSObject frame = new JSObject();
        frame.put("data", Base64.encodeToString(jpeg, Base64.NO_WRAP));
        notifyListeners("frame", frame);
    };

    /** Sound thread: every 20 ms chunk goes (none dropped), in order, through the main thread. */
    @Override
    public void onAudio(byte[] pcm) {
        final int ch = audioChannels;
        main.post(() -> {
            if (!ScreenCaptureService.isRunning()) return;
            if (binary && reply != null) {
                byte[] msg = new byte[4 + pcm.length];
                msg[0] = 'P';
                msg[1] = 'C';
                msg[2] = 'M';
                msg[3] = (byte) ch;
                System.arraycopy(pcm, 0, msg, 4, pcm.length);
                try {
                    reply.postMessage(msg);
                    return;
                } catch (RuntimeException e) {
                    binary = false;
                }
            }
            JSObject a = new JSObject();
            a.put("data", Base64.encodeToString(pcm, Base64.NO_WRAP));
            a.put("channels", ch);
            notifyListeners("audio", a);
        });
    }

    @Override
    protected void handleOnDestroy() {
        ScreenCaptureService.stopNow("closed");
        ScreenCaptureService.setListener(null);
    }

    private static int clamp(Integer v, int lo, int hi) {
        int x = v == null ? lo : v;
        return Math.max(lo, Math.min(hi, x));
    }
}
