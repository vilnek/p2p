package com.vilnek.p2p;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.IntentCompat;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Screen sharing: captures the phone's screen while a call shares it.
 *
 * Android 10+ needs a foreground service of type mediaProjection running BEFORE
 * getMediaProjection(), so the capture lives here, with the ongoing notification
 * "P2P Talk is sharing your screen" and its Stop button.
 *
 * Screen -> VirtualDisplay (already scaled down) -> ImageReader (RGBA) -> JPEG -> Listener.
 * At most `fps` frames a second, always the newest picture. Rotation and (Android 14+)
 * "share one app" size changes resize the same VirtualDisplay (a second one is not allowed).
 *
 * Sound (Android 10+, when asked): what other apps play (media, games, unknown), through
 * AudioPlaybackCapture on the same projection; never P2P Talk's own sound (the call), never the
 * microphone. Apps that forbid capture (many banking and streaming apps, phone calls) stay silent.
 *
 * P2P Talk's own window is black in the capture (FLAG_SECURE), on purpose.
 */
public class ScreenCaptureService extends Service {

    static final String ACTION_START = "com.vilnek.p2p.screen.START";
    static final String ACTION_STOP = "com.vilnek.p2p.screen.STOP";
    static final String EXTRA_RESULT_CODE = "resultCode";
    static final String EXTRA_DATA = "data";
    static final String EXTRA_MAX_WIDTH = "maxWidth";
    static final String EXTRA_MAX_HEIGHT = "maxHeight";
    static final String EXTRA_FPS = "fps";
    static final String EXTRA_AUDIO = "audio";

    private static final String TAG = "P2PScreen";
    private static final String CHANNEL = "screen_share";
    private static final int NOTIFICATION_ID = 4101;
    private static final int JPEG_QUALITY = 70;

    /** What the plugin hears. Called on the capture threads (frames, sound) or the main thread (the rest). */
    interface Listener {
        /** channels: the phone's sound comes too (1 or 2), or 0 (no sound: not asked, or Android 9 and older). */
        void onStarted(int width, int height, int channels);
        void onFrame(byte[] jpeg);
        /** 20 ms of sound: 48 kHz, 16-bit, interleaved channels. */
        void onAudio(byte[] pcm);
        void onStopped(String reason);
        void onFailed(String message);
    }

    private static volatile Listener listener;
    private static ScreenCaptureService running; // main thread only

    static void setListener(Listener l) {
        listener = l;
    }

    /** Stop sharing now (main thread). Safe when nothing is shared. */
    static void stopNow(String reason) {
        if (running != null) running.finish(reason);
    }

    static boolean isRunning() {
        return running != null;
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread thread;
    private Handler capture;
    private DisplayManager displays;
    private int maxWidth = 1280;
    private int maxHeight = 1280;
    private long frameGapMs = 100;
    private int contentWidth; // Android 14+ "share one app": that app's size (0: the whole screen)
    private int contentHeight;
    private int width;
    private int height;
    private boolean finished;
    private boolean wantAudio;
    private Thread audioThread;
    private volatile AudioRecord audio;

    // Capture thread only.
    private boolean grabQueued;
    private long lastFrameAt;
    private Bitmap rowBitmap;
    private final ByteArrayOutputStream jpeg = new ByteArrayOutputStream(128 * 1024);
    private int statFrames;
    private long statEncodeMs;
    private long statBytes;
    private long statSince;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            // The Stop button in the notification.
            if (running == this) finish("user");
            else stopSelf();
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (running != null) return START_NOT_STICKY; // already sharing
        running = this;
        finished = false;
        contentWidth = 0;
        contentHeight = 0;
        maxWidth = intent.getIntExtra(EXTRA_MAX_WIDTH, 1280);
        maxHeight = intent.getIntExtra(EXTRA_MAX_HEIGHT, 1280);
        frameGapMs = 1000L / Math.max(1, intent.getIntExtra(EXTRA_FPS, 10));
        wantAudio = intent.getBooleanExtra(EXTRA_AUDIO, false);

        // 1. The foreground service first (Android 10+ refuses the projection otherwise).
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type);
        } catch (RuntimeException e) {
            fail("Screen sharing could not start.", e);
            return START_NOT_STICKY;
        }

        // 2. The projection, from the consent the user just gave (single use on Android 14+).
        Intent data = IntentCompat.getParcelableExtra(intent, EXTRA_DATA, Intent.class);
        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED);
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        try {
            projection = data != null && mpm != null ? mpm.getMediaProjection(resultCode, data) : null;
        } catch (RuntimeException e) {
            projection = null;
        }
        if (projection == null) {
            fail("Screen sharing could not start.", null);
            return START_NOT_STICKY;
        }
        // Required before createVirtualDisplay on Android 14+.
        projection.registerCallback(new ProjectionCallback(), main);

        // 3. The capture.
        thread = new HandlerThread("P2PScreen");
        thread.start();
        capture = new Handler(thread.getLooper());
        displays = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
        int[] size = targetSize();
        width = size[0];
        height = size[1];
        reader = newReader(width, height);
        try {
            display = projection.createVirtualDisplay(
                "P2P Talk screen",
                width,
                height,
                screenDpi(),
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.getSurface(),
                null,
                capture
            );
        } catch (RuntimeException e) {
            fail("Screen sharing could not start.", e);
            return START_NOT_STICKY;
        }
        displays.registerDisplayListener(rotation, main);
        int channels = wantAudio ? startAudio() : 0;
        Listener l = listener;
        if (l != null) l.onStarted(width, height, channels);
        return START_NOT_STICKY;
    }

    // ---- sound (Android 10+) -----------------------------------------------------------------

    private static final int RATE = 48000;

    /** Starts capturing other apps' sound. Returns the channels (2 or 1), or 0 when it can't. */
    private int startAudio() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return 0;
        AudioPlaybackCaptureConfiguration config = new AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .excludeUid(getApplicationInfo().uid) // never our own call sound
            .build();
        for (int mask : new int[] { AudioFormat.CHANNEL_IN_STEREO, AudioFormat.CHANNEL_IN_MONO }) {
            int channels = mask == AudioFormat.CHANNEL_IN_STEREO ? 2 : 1;
            int chunk = RATE / 50 * channels * 2; // 20 ms
            int min = AudioRecord.getMinBufferSize(RATE, mask, AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) continue;
            AudioRecord r = null;
            try {
                r = new AudioRecord.Builder()
                    .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(mask).build())
                    .setBufferSizeInBytes(Math.max(min, chunk * 10))
                    .setAudioPlaybackCaptureConfig(config)
                    .build();
                if (r.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("not initialized");
                r.startRecording();
            } catch (RuntimeException e) {
                Log.w(TAG, "sound capture unavailable (" + channels + " ch)", e);
                if (r != null) r.release();
                continue;
            }
            audio = r;
            final AudioRecord rec = r;
            audioThread = new Thread(() -> readAudio(rec, chunk), "P2PScreenSound");
            audioThread.setPriority(Thread.MAX_PRIORITY);
            audioThread.start();
            return channels;
        }
        return 0;
    }

    /** Sound thread: 20 ms at a time to the plugin until stopped. */
    private void readAudio(AudioRecord rec, int chunk) {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);
        while (audio == rec) {
            byte[] buf = new byte[chunk];
            int got = 0;
            while (got < chunk && audio == rec) {
                int n = rec.read(buf, got, chunk - got);
                if (n <= 0) break;
                got += n;
            }
            if (got < chunk) {
                if (audio != rec) break;
                SystemClock.sleep(5); // nothing to read (e.g. recording stopped)
                continue;
            }
            Listener l = listener;
            if (l != null) l.onAudio(buf);
        }
        rec.release();
    }

    private void stopAudio() {
        AudioRecord r = audio;
        audio = null; // the sound thread ends and releases it
        if (r != null) {
            try {
                r.stop();
            } catch (RuntimeException ignored) {
                // already stopped
            }
        }
        audioThread = null;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The app was swiped away: stop sharing.
        finish("closed");
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        finish("ended");
        super.onDestroy();
    }

    // ---- notification ------------------------------------------------------------------------

    private Notification notification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while you share your screen in a call");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        int immutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;
        Intent stop = new Intent(this, ScreenCaptureService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, immutable | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 2, open, immutable | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_screen_share)
            .setContentTitle("P2P Talk is sharing your screen")
            .setContentText(wantAudio ? "The other person can see your screen and hear your phone's sound." : "The other person can see your screen.")
            .setContentIntent(openPi)
            .addAction(0, "Stop", stopPi)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    // ---- sizes -------------------------------------------------------------------------------

    @SuppressWarnings("deprecation")
    private DisplayMetrics screen() {
        DisplayMetrics m = new DisplayMetrics();
        DisplayManager dm = displays != null ? displays : (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
        Display d = dm != null ? dm.getDisplay(Display.DEFAULT_DISPLAY) : null;
        if (d != null) d.getRealMetrics(m);
        else m.setTo(getResources().getDisplayMetrics());
        return m;
    }

    private int screenDpi() {
        return screen().densityDpi;
    }

    /** The screen (or the shared app) fitted inside maxWidth x maxHeight, never larger, even numbers. */
    private int[] targetSize() {
        int sw = contentWidth;
        int sh = contentHeight;
        if (sw <= 0 || sh <= 0) {
            DisplayMetrics m = screen();
            sw = m.widthPixels;
            sh = m.heightPixels;
        }
        double scale = Math.min(1.0, Math.min((double) maxWidth / sw, (double) maxHeight / sh));
        int w = Math.max(2, ((int) Math.round(sw * scale)) & ~1);
        int h = Math.max(2, ((int) Math.round(sh * scale)) & ~1);
        return new int[] { w, h };
    }

    private ImageReader newReader(int w, int h) {
        ImageReader r = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 3);
        r.setOnImageAvailableListener(this::onImage, capture);
        return r;
    }

    /** Rotation or a new shared-app size: same VirtualDisplay, new size and a new ImageReader. */
    private void resizeIfNeeded() {
        if (finished || display == null) return;
        int[] size = targetSize();
        if (size[0] == width && size[1] == height) return;
        width = size[0];
        height = size[1];
        final ImageReader old = reader;
        reader = newReader(width, height);
        display.resize(width, height, screenDpi());
        display.setSurface(reader.getSurface());
        capture.post(() -> {
            rowBitmap = null;
            old.close();
        });
    }

    private final DisplayManager.DisplayListener rotation = new DisplayManager.DisplayListener() {
        @Override
        public void onDisplayAdded(int displayId) {}

        @Override
        public void onDisplayRemoved(int displayId) {}

        @Override
        public void onDisplayChanged(int displayId) {
            if (displayId == Display.DEFAULT_DISPLAY) resizeIfNeeded();
        }
    };

    private class ProjectionCallback extends MediaProjection.Callback {

        @Override
        public void onStop() {
            // Android ended it: the system "Stop sharing" chip, screen lock (Android 15+), another app took it.
            main.post(() -> finish("ended"));
        }

        @Override
        public void onCapturedContentResize(int w, int h) {
            // Android 14+: the size of what is shared (one app, or the whole screen).
            main.post(() -> {
                contentWidth = w;
                contentHeight = h;
                resizeIfNeeded();
            });
        }
    }

    // ---- frames (capture thread) -------------------------------------------------------------

    private void onImage(ImageReader r) {
        if (grabQueued) return;
        grabQueued = true;
        long wait = Math.max(0, lastFrameAt + frameGapMs - SystemClock.elapsedRealtime());
        capture.postDelayed(grab, wait);
    }

    /** Takes the newest picture (older ones are skipped) and sends it as a JPEG. */
    private final Runnable grab = () -> {
        grabQueued = false;
        ImageReader r = reader;
        if (finished || r == null) return;
        Image img;
        try {
            img = r.acquireLatestImage();
        } catch (RuntimeException e) {
            return; // the reader was just replaced (rotation)
        }
        if (img == null) return;
        try {
            long t0 = SystemClock.elapsedRealtime();
            lastFrameAt = t0;
            int w = img.getWidth();
            int h = img.getHeight();
            Image.Plane plane = img.getPlanes()[0];
            int rowPixels = plane.getRowStride() / plane.getPixelStride();
            if (rowBitmap == null || rowBitmap.getWidth() != rowPixels || rowBitmap.getHeight() != h) {
                rowBitmap = Bitmap.createBitmap(rowPixels, h, Bitmap.Config.ARGB_8888);
            }
            ByteBuffer pixels = plane.getBuffer();
            pixels.rewind();
            rowBitmap.copyPixelsFromBuffer(pixels);
            // Rows can have padding at the end; cut it off.
            Bitmap frame = rowPixels == w ? rowBitmap : Bitmap.createBitmap(rowBitmap, 0, 0, w, h);
            jpeg.reset();
            frame.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, jpeg);
            if (frame != rowBitmap) frame.recycle();
            byte[] out = jpeg.toByteArray();
            Listener l = listener;
            if (l != null) l.onFrame(out);
            stats(SystemClock.elapsedRealtime() - t0, out.length);
        } catch (RuntimeException e) {
            Log.w(TAG, "frame skipped", e);
        } finally {
            img.close();
        }
    };

    /** Debug builds: fps, encode time and size every 5 s in the log (adb logcat -s P2PScreen). */
    private void stats(long encodeMs, int bytes) {
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) return;
        long now = SystemClock.elapsedRealtime();
        if (statSince == 0) statSince = now;
        statFrames++;
        statEncodeMs += encodeMs;
        statBytes += bytes;
        if (now - statSince >= 5000) {
            double secs = (now - statSince) / 1000.0;
            Log.i(
                TAG,
                String.format(
                    java.util.Locale.ROOT,
                    "%dx%d fps=%.1f encode=%.1fms size=%.0fKB",
                    width,
                    height,
                    statFrames / secs,
                    (double) statEncodeMs / statFrames,
                    statBytes / 1024.0 / statFrames
                )
            );
            statSince = now;
            statFrames = 0;
            statEncodeMs = 0;
            statBytes = 0;
        }
    }

    // ---- stopping ----------------------------------------------------------------------------

    private void fail(String message, Exception e) {
        if (e != null) Log.w(TAG, message, e);
        Listener l = listener;
        release();
        if (l != null) l.onFailed(message);
    }

    /** Stops everything once and tells the plugin why ("user", "app", "ended", "closed"). */
    private void finish(String reason) {
        if (finished) return;
        boolean started = display != null;
        release();
        Listener l = listener;
        if (l != null && started) l.onStopped(reason);
    }

    private void release() {
        if (finished) return;
        finished = true;
        if (running == this) running = null;
        stopAudio();
        if (displays != null) displays.unregisterDisplayListener(rotation);
        if (display != null) display.release();
        display = null;
        if (projection != null) projection.stop();
        projection = null;
        final ImageReader r = reader;
        reader = null;
        if (thread != null) {
            capture.removeCallbacksAndMessages(null);
            capture.post(() -> {
                if (r != null) r.close();
                rowBitmap = null;
            });
            thread.quitSafely();
        } else if (r != null) {
            r.close();
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }
}
