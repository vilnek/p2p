package com.vilnek.p2p;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.media.MediaMetadataRetriever;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * "NativeFiles": photos, videos and files sent as the ORIGINAL bytes, and received files saved to
 * the gallery, to a folder, or shared. The web side is p2p/src/native/nativeFiles.ts.
 *
 *   pick({ kind: media|files|camera, multiple, video }) -> { files: [{ handle, name, size, mime }] }
 *       media: the Photo Picker (Android 11+; falls back to the document picker on older phones).
 *       files: the document picker, any type. camera: the camera app writes into a temporary file.
 *       Picked items are read straight from their content Uri at any position (no copy), unless
 *       the provider can't seek: then they are copied to a temporary file first. Closed: files [].
 *   read({ handle, offset, length }) -> { data: base64 }        (fallback for the binary channel)
 *   release({ handle })
 *   create({ name, mime, size }) -> { handle }                  a received file, written in place
 *   write({ handle, offset, data: base64 })                     (fallback for the binary channel)
 *   finish({ handle, size }) -> { ref, size }                   moved to the app's received folder
 *   abort({ handle })
 *   saveToPhotos({ ref, name, mime })   Pictures/P2P Talk or Movies/P2P Talk (MediaStore; Android
 *                                       6-9 asks for storage access at that moment)
 *   saveToFiles({ ref, name, mime }) -> { saved }    the system "Save to" folder picker
 *   share({ ref, name, mime })          the share sheet, with "open with" apps first
 *   thumb({ ref, mime, max }) -> { data }  a small JPEG preview of a received photo or video
 *   remove({ ref }), cleanup({ keep? }), info() -> { binary, range, platform }
 *
 * Binary channel (fast path, no base64): the page's "P2PFiles" object (WebViewCompat web message
 * listener, this app's own page only, main frame only).
 *   page -> app  string  {"op":"read","id","h","o","n"}  -> app replies ArrayBuffer [u32 id LE][bytes]
 *   page -> app  ArrayBuffer [op=1][pad3][u32 id][u32 handle][pad4][f64 offset][bytes] (write)
 *                                                       -> app replies string {"id","ok":true}
 *   Errors: string {"id","err","code"}.
 *
 * Temporary files: cache/p2p-tmp (camera, copies) and files/p2p-partial (receiving) are emptied
 * when the app starts, after a cancel and after a save. Received files: files/p2p-received/<id>/<name>.
 */
@CapacitorPlugin(
    name = "NativeFiles",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class NativeFilesPlugin extends Plugin {

    private static final String TMP = "p2p-tmp";
    private static final String PARTIAL = "p2p-partial";
    private static final String RECEIVED = "p2p-received";
    private static final String GALLERY_FOLDER = "P2P Talk";
    private static final int MAX_READ = 16 * 1024 * 1024;
    private static final long SPACE_MARGIN = 50L * 1024 * 1024;
    private static final Pattern REF = Pattern.compile("^[A-Za-z0-9_-]{1,64}/[^/\\\\]{1,255}$");

    private static final class Source {
        final FileChannel ch;
        final File temp; // our own copy (deleted on release), or null
        final long size;

        Source(FileChannel ch, File temp, long size) {
            this.ch = ch;
            this.temp = temp;
            this.size = size;
        }
    }

    private static final class Sink {
        final RandomAccessFile raf;
        final FileChannel ch;
        final File partial;
        final String name;

        Sink(RandomAccessFile raf, File partial, String name) {
            this.raf = raf;
            this.ch = raf.getChannel();
            this.partial = partial;
            this.name = name;
        }
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newFixedThreadPool(3);
    private final ConcurrentHashMap<Integer, Source> sources = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Integer, Sink> sinks = new ConcurrentHashMap<>();
    private final AtomicInteger nextHandle = new AtomicInteger(1);
    private volatile boolean binary = false;

    // ---- start ------------------------------------------------------------------------------------

    @Override
    public void load() {
        // Leftovers of the last run: unfinished receives and temporary copies.
        io.execute(() -> {
            emptyDir(dir(false, TMP), Collections.emptySet());
            emptyDir(dir(true, PARTIAL), Collections.emptySet());
        });
        WebView webView = getBridge().getWebView();
        if (
            webView == null ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        ) return;
        try {
            Uri local = Uri.parse(getBridge().getLocalUrl());
            String origin = local.getScheme() + "://" + local.getAuthority();
            WebViewCompat.addWebMessageListener(
                webView,
                "P2PFiles",
                Collections.singleton(origin),
                (view, message, sourceOrigin, isMainFrame, reply) -> {
                    if (isMainFrame) onPortMessage(message, reply);
                }
            );
            binary = true;
        } catch (RuntimeException e) {
            binary = false;
        }
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("binary", binary);
        r.put("range", false); // the local server's Range answer reads from the start each time (slow for big files)
        r.put("platform", "android");
        call.resolve(r);
    }

    // ---- binary channel -----------------------------------------------------------------------------

    private void onPortMessage(WebMessageCompat message, JavaScriptReplyProxy reply) {
        if (message.getType() == WebMessageCompat.TYPE_ARRAY_BUFFER) {
            final byte[] b = message.getArrayBuffer();
            io.execute(() -> portWrite(b, reply));
        } else {
            final String s = message.getData();
            if (s != null) io.execute(() -> portRead(s, reply));
        }
    }

    private void portRead(String s, JavaScriptReplyProxy reply) {
        int id = 0;
        try {
            JSONObject m = new JSONObject(s);
            id = m.getInt("id");
            if (!"read".equals(m.optString("op"))) return;
            Source src = sources.get(m.getInt("h"));
            if (src == null) {
                replyError(reply, id, "This file is no longer on this phone.", "missing");
                return;
            }
            long offset = (long) m.getDouble("o");
            int n = (int) Math.min(MAX_READ, Math.max(0, m.getLong("n")));
            ByteBuffer buf = ByteBuffer.allocate(4 + n).order(ByteOrder.LITTLE_ENDIAN);
            buf.putInt(id);
            readFully(src.ch, buf, offset);
            final byte[] out = buf.position() == buf.capacity() ? buf.array() : Arrays.copyOf(buf.array(), buf.position());
            main.post(() -> {
                try {
                    reply.postMessage(out);
                } catch (RuntimeException ignored) {}
            });
        } catch (Exception e) {
            replyError(reply, id, "The file could not be read.", "failed");
        }
    }

    private void portWrite(byte[] b, JavaScriptReplyProxy reply) {
        if (b.length < 24) return;
        ByteBuffer h = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN);
        int id = h.getInt(4);
        try {
            if (h.get(0) != 1) throw new IOException("bad op");
            Sink sink = sinks.get(h.getInt(8));
            if (sink == null) {
                replyError(reply, id, "This file was closed.", "missing");
                return;
            }
            long offset = (long) h.getDouble(16);
            writeFully(sink.ch, ByteBuffer.wrap(b, 24, b.length - 24), offset);
            final String ok = "{\"id\":" + id + ",\"ok\":true}";
            main.post(() -> {
                try {
                    reply.postMessage(ok);
                } catch (RuntimeException ignored) {}
            });
        } catch (Exception e) {
            replyError(reply, id, "The file could not be written. Is the phone full?", "failed");
        }
    }

    private void replyError(JavaScriptReplyProxy reply, int id, String message, String code) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("err", message);
            o.put("code", code);
            final String s = o.toString();
            main.post(() -> {
                try {
                    reply.postMessage(s);
                } catch (RuntimeException ignored) {}
            });
        } catch (Exception ignored) {}
    }

    // ---- picking ------------------------------------------------------------------------------------

    @PluginMethod
    public void pick(PluginCall call) {
        String kind = call.getString("kind", "files");
        boolean multiple = Boolean.TRUE.equals(call.getBoolean("multiple", true));
        try {
            if ("media".equals(kind)) {
                PickVisualMediaRequest req = new PickVisualMediaRequest.Builder()
                    .setMediaType(ActivityResultContracts.PickVisualMedia.ImageAndVideo.INSTANCE)
                    .build();
                Intent i = multiple
                    ? new ActivityResultContracts.PickMultipleVisualMedia().createIntent(getContext(), req)
                    : new ActivityResultContracts.PickVisualMedia().createIntent(getContext(), req);
                startActivityForResult(call, i, "picked");
            } else if ("camera".equals(kind)) {
                if (getPermissionState("camera") != PermissionState.GRANTED) {
                    requestPermissionForAlias("camera", call, "cameraAnswered");
                } else {
                    launchCamera(call);
                }
            } else {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
                startActivityForResult(call, i, "picked");
            }
        } catch (ActivityNotFoundException e) {
            call.reject("This phone has no app to choose files.", "unsupported");
        }
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            resolveFiles(call, new JSArray());
            return;
        }
        final List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null && !uris.contains(u)) uris.add(u);
            }
        }
        if (data.getData() != null && !uris.contains(data.getData())) uris.add(data.getData());
        io.execute(() -> {
            JSArray files = new JSArray();
            try {
                for (Uri u : uris) files.put(openUri(u, null));
                resolveFiles(call, files);
            } catch (Exception e) {
                releaseAll(files);
                call.reject("The file could not be opened.", "failed");
            }
        });
    }

    @PermissionCallback
    private void cameraAnswered(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) launchCamera(call);
        else call.reject("P2P Talk is not allowed to use the camera. You can allow it in Settings.", "denied");
    }

    private void launchCamera(PluginCall call) {
        boolean video = Boolean.TRUE.equals(call.getBoolean("video", false));
        String stamp = new SimpleDateFormat("yyyy-MM-dd HH.mm.ss", Locale.US).format(new Date());
        File f = new File(dir(false, TMP), (video ? "Video " : "Photo ") + stamp + (video ? ".mp4" : ".jpg"));
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(video ? MediaStore.ACTION_VIDEO_CAPTURE : MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            i.setClipData(ClipData.newRawUri("", uri));
            call.getData().put("_camera", f.getAbsolutePath());
            startActivityForResult(call, i, "cameraDone");
        } catch (ActivityNotFoundException e) {
            call.reject("This phone has no camera app.", "unsupported");
        } catch (RuntimeException e) {
            call.reject("The camera could not start.", "failed");
        }
    }

    @ActivityCallback
    private void cameraDone(PluginCall call, ActivityResult result) {
        if (call == null) return;
        final File f = new File(call.getString("_camera", ""));
        final Intent data = result.getData();
        final boolean ok = result.getResultCode() == Activity.RESULT_OK;
        io.execute(() -> {
            JSArray files = new JSArray();
            try {
                if (ok && f.isFile() && f.length() > 0) {
                    files.put(openFile(f, f.getName(), true));
                } else {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                    // Some camera apps ignore EXTRA_OUTPUT for videos and return their own Uri.
                    if (ok && data != null && data.getData() != null) files.put(openUri(data.getData(), null));
                }
                resolveFiles(call, files);
            } catch (Exception e) {
                releaseAll(files);
                call.reject("The photo could not be opened.", "failed");
            }
        });
    }

    private void resolveFiles(PluginCall call, JSArray files) {
        JSObject r = new JSObject();
        r.put("files", files);
        call.resolve(r);
    }

    /** Opens a content Uri for reading at any position; copies it first if the provider can't seek. */
    private JSObject openUri(Uri uri, String fallbackName) throws IOException {
        ContentResolver cr = getContext().getContentResolver();
        String name = null;
        long size = -1;
        try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int si = c.getColumnIndex(OpenableColumns.SIZE);
                if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni);
                if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
            }
        } catch (RuntimeException ignored) {}
        if (name == null || name.isEmpty()) name = fallbackName != null ? fallbackName : uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "file";
        String mime = cr.getType(uri);
        if (mime == null || mime.isEmpty()) mime = mimeFromName(name);

        ParcelFileDescriptor pfd = cr.openFileDescriptor(uri, "r");
        if (pfd == null) throw new IOException("no descriptor");
        FileChannel ch = new ParcelFileDescriptor.AutoCloseInputStream(pfd).getChannel();
        long stat = pfd.getStatSize();
        boolean seekable;
        try {
            ch.position(0);
            seekable = stat >= 0;
        } catch (IOException e) {
            seekable = false;
        }
        Source src;
        if (seekable) {
            src = new Source(ch, null, stat);
        } else {
            // A stream only (e.g. some cloud providers): keep a temporary copy to read at any position.
            closeQuietly(ch);
            File copy = new File(dir(false, TMP), UUID.randomUUID() + ".copy");
            try (InputStream in = cr.openInputStream(uri); OutputStream out = new FileOutputStream(copy)) {
                if (in == null) throw new IOException("no stream");
                copy(in, out);
            } catch (IOException e) {
                //noinspection ResultOfMethodCallIgnored
                copy.delete();
                throw e;
            }
            src = new Source(new RandomAccessFile(copy, "r").getChannel(), copy, copy.length());
        }
        int handle = nextHandle.getAndIncrement();
        sources.put(handle, src);
        JSObject o = new JSObject();
        o.put("handle", handle);
        o.put("name", name);
        o.put("size", src.size);
        o.put("mime", mime);
        return o;
    }

    private JSObject openFile(File f, String name, boolean temp) throws IOException {
        Source src = new Source(new RandomAccessFile(f, "r").getChannel(), temp ? f : null, f.length());
        int handle = nextHandle.getAndIncrement();
        sources.put(handle, src);
        JSObject o = new JSObject();
        o.put("handle", handle);
        o.put("name", name);
        o.put("size", src.size);
        o.put("mime", mimeFromName(name));
        return o;
    }

    private void releaseAll(JSArray files) {
        for (int i = 0; i < files.length(); i++) {
            JSONObject o = files.optJSONObject(i);
            if (o != null) releaseSource(o.optInt("handle", -1));
        }
    }

    @PluginMethod
    public void read(PluginCall call) {
        final Source src = sources.get(call.getInt("handle", -1));
        if (src == null) {
            call.reject("This file is no longer on this phone.", "missing");
            return;
        }
        final long offset = num(call, "offset", 0L);
        final int n = (int) Math.min(MAX_READ, Math.max(0, num(call, "length", 0L)));
        io.execute(() -> {
            try {
                ByteBuffer buf = ByteBuffer.allocate(n);
                readFully(src.ch, buf, offset);
                JSObject r = new JSObject();
                r.put("data", Base64.encodeToString(buf.array(), 0, buf.position(), Base64.NO_WRAP));
                call.resolve(r);
            } catch (Exception e) {
                call.reject("The file could not be read.", "failed");
            }
        });
    }

    @PluginMethod
    public void release(PluginCall call) {
        releaseSource(call.getInt("handle", -1));
        call.resolve();
    }

    private void releaseSource(int handle) {
        Source s = sources.remove(handle);
        if (s == null) return;
        closeQuietly(s.ch);
        //noinspection ResultOfMethodCallIgnored
        if (s.temp != null) s.temp.delete();
    }

    // ---- receiving ----------------------------------------------------------------------------------

    @PluginMethod
    public void create(PluginCall call) {
        final String name = fsName(call.getString("name", "file"));
        final long size = Math.max(0, num(call, "size", 0L));
        io.execute(() -> {
            try {
                File d = dir(true, PARTIAL);
                if (d.getUsableSpace() < size + SPACE_MARGIN) {
                    call.reject("There is not enough free space on this phone for this file.", "failed");
                    return;
                }
                File partial = new File(d, UUID.randomUUID() + ".part");
                int handle = nextHandle.getAndIncrement();
                sinks.put(handle, new Sink(new RandomAccessFile(partial, "rw"), partial, name));
                JSObject r = new JSObject();
                r.put("handle", handle);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("The file could not be made on this phone.", "failed");
            }
        });
    }

    @PluginMethod
    public void write(PluginCall call) {
        final Sink sink = sinks.get(call.getInt("handle", -1));
        if (sink == null) {
            call.reject("This file was closed.", "missing");
            return;
        }
        final long offset = num(call, "offset", 0L);
        final String data = call.getString("data", "");
        io.execute(() -> {
            try {
                writeFully(sink.ch, ByteBuffer.wrap(Base64.decode(data, Base64.DEFAULT)), offset);
                call.resolve();
            } catch (Exception e) {
                call.reject("The file could not be written. Is the phone full?", "failed");
            }
        });
    }

    @PluginMethod
    public void finish(PluginCall call) {
        final int handle = call.getInt("handle", -1);
        final Long expected = num(call, "size", null);
        io.execute(() -> {
            Sink sink = sinks.remove(handle);
            if (sink == null) {
                call.reject("This file was closed.", "missing");
                return;
            }
            try {
                long size = sink.ch.size();
                if (expected != null && size != expected) {
                    sink.raf.setLength(expected); // an empty or sparse end: never larger than offered
                    size = sink.ch.size();
                }
                sink.ch.force(false);
                sink.raf.close();
                String id = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
                File d = new File(dir(true, RECEIVED), id);
                if (!d.mkdirs()) throw new IOException("mkdirs");
                File target = new File(d, sink.name);
                if (!sink.partial.renameTo(target)) throw new IOException("rename");
                JSObject r = new JSObject();
                r.put("ref", id + "/" + sink.name);
                r.put("size", size);
                call.resolve(r);
            } catch (Exception e) {
                closeQuietly(sink.raf);
                //noinspection ResultOfMethodCallIgnored
                sink.partial.delete();
                call.reject("The file could not be finished.", "failed");
            }
        });
    }

    @PluginMethod
    public void abort(PluginCall call) {
        Sink sink = sinks.remove(call.getInt("handle", -1));
        if (sink != null) {
            closeQuietly(sink.raf);
            //noinspection ResultOfMethodCallIgnored
            sink.partial.delete();
        }
        call.resolve();
    }

    // ---- saving -------------------------------------------------------------------------------------

    @PluginMethod
    public void saveToPhotos(PluginCall call) {
        if (received(call) == null) return;
        String mime = call.getString("mime", "");
        if (mime == null || !(mime.startsWith("image/") || mime.startsWith("video/"))) {
            call.reject("Photos cannot keep this type of file. Use Save to Files.", "unsupported");
            return;
        }
        if (Build.VERSION.SDK_INT < 29 && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storageAnswered");
            return;
        }
        savePhotosNow(call);
    }

    @PermissionCallback
    private void storageAnswered(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) savePhotosNow(call);
        else call.reject("P2P Talk is not allowed to save to your photos. You can allow it in Settings.", "denied");
    }

    private void savePhotosNow(PluginCall call) {
        final File f = received(call);
        if (f == null) return;
        final String name = fsName(call.getString("name", f.getName()));
        final String mime = call.getString("mime", "");
        io.execute(() -> {
            try {
                Uri uri = Build.VERSION.SDK_INT >= 29 ? insertIntoMediaStore(f, name, mime) : saveToPublicFolder(f, name, mime);
                JSObject r = new JSObject();
                r.put("uri", uri.toString());
                call.resolve(r);
            } catch (IllegalArgumentException e) {
                call.reject("Photos cannot keep this type of file. Use Save to Files.", "unsupported");
            } catch (Exception e) {
                call.reject("The file could not be saved to Photos. Is the phone full?", "failed");
            }
        });
    }

    /** Android 10+: no permission needed. Hidden (IS_PENDING) until every byte is written. */
    private Uri insertIntoMediaStore(File f, String name, String mime) throws IOException {
        boolean video = mime.startsWith("video/");
        Uri collection = video
            ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            : MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, (video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES) + "/" + GALLERY_FOLDER);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        ContentResolver cr = getContext().getContentResolver();
        Uri item = cr.insert(collection, v);
        if (item == null) throw new IOException("insert");
        try {
            try (OutputStream out = cr.openOutputStream(item, "w"); InputStream in = new FileInputStream(f)) {
                if (out == null) throw new IOException("no stream");
                copy(in, out);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(item, done, null, null);
            return item;
        } catch (IOException | RuntimeException e) {
            try {
                cr.delete(item, null, null);
            } catch (RuntimeException ignored) {}
            throw e;
        }
    }

    /** Android 6-9: a file in Pictures/P2P Talk or Movies/P2P Talk, then the media scanner. */
    @SuppressWarnings("deprecation")
    private Uri saveToPublicFolder(File f, String name, String mime) throws IOException {
        boolean video = mime.startsWith("video/");
        File d = new File(Environment.getExternalStoragePublicDirectory(video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES), GALLERY_FOLDER);
        if (!d.isDirectory() && !d.mkdirs()) throw new IOException("mkdirs");
        File out = unique(d, name);
        try (InputStream in = new FileInputStream(f); OutputStream o = new FileOutputStream(out)) {
            copy(in, o);
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            throw e;
        }
        MediaScannerConnection.scanFile(getContext(), new String[] { out.getAbsolutePath() }, new String[] { mime }, null);
        return Uri.fromFile(out);
    }

    @PluginMethod
    public void saveToFiles(PluginCall call) {
        File f = received(call);
        if (f == null) return;
        String mime = call.getString("mime", "");
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
        i.putExtra(Intent.EXTRA_TITLE, fsName(call.getString("name", f.getName())));
        try {
            startActivityForResult(call, i, "createDone");
        } catch (ActivityNotFoundException e) {
            call.reject("This phone has no app to save files.", "unsupported");
        }
    }

    @ActivityCallback
    private void createDone(PluginCall call, ActivityResult result) {
        if (call == null) return;
        final File f = received(call);
        if (f == null) return;
        final Uri target = result.getData() != null ? result.getData().getData() : null;
        if (result.getResultCode() != Activity.RESULT_OK || target == null) {
            JSObject r = new JSObject();
            r.put("saved", false);
            call.resolve(r);
            return;
        }
        io.execute(() -> {
            ContentResolver cr = getContext().getContentResolver();
            try (OutputStream out = cr.openOutputStream(target, "w"); InputStream in = new FileInputStream(f)) {
                if (out == null) throw new IOException("no stream");
                copy(in, out);
                JSObject r = new JSObject();
                r.put("saved", true);
                call.resolve(r);
            } catch (Exception e) {
                try {
                    DocumentsContract.deleteDocument(cr, target);
                } catch (Exception ignored) {}
                call.reject("The file could not be saved there. Is there enough space?", "failed");
            }
        });
    }

    @PluginMethod
    public void share(PluginCall call) {
        File f = received(call);
        if (f == null) return;
        String name = fsName(call.getString("name", f.getName()));
        String mime = call.getString("mime", "");
        if (mime == null || mime.isEmpty()) mime = mimeFromName(name);
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f, name);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.setClipData(ClipData.newRawUri(name, uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setDataAndType(uri, mime);
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Share or open");
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] { view });
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(chooser);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this phone can open or share this file.", "unsupported");
        } catch (RuntimeException e) {
            call.reject("The file could not be shared.", "failed");
        }
    }

    /**
     * thumb({ ref, mime, max }) -> { data: base64 JPEG }: a small preview of a received photo or video,
     * decoded at a reduced size (a big photo is never decoded whole), turned the right way up. The
     * received file itself is not changed.
     */
    @PluginMethod
    public void thumb(PluginCall call) {
        File f = received(call);
        if (f == null) return;
        String mime = call.getString("mime", "");
        String m = mime == null ? "" : mime.toLowerCase(Locale.ROOT);
        Long req = num(call, "max", 360L);
        final int max = (int) Math.max(64, Math.min(1024, req == null ? 360 : req));
        io.execute(() -> {
            Bitmap b = null;
            try {
                if (m.startsWith("video/")) b = videoFrame(f, max);
                else if (m.startsWith("image/")) b = scaledImage(f, max);
            } catch (Throwable ignored) {
                b = null;
            }
            if (b == null) {
                call.reject("No preview for this file.", "unsupported");
                return;
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            b.compress(Bitmap.CompressFormat.JPEG, 78, out);
            b.recycle();
            JSObject r = new JSObject();
            r.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(r);
        });
    }

    private static Bitmap scaledImage(File f, int max) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Reads HEIC too, and applies the photo's rotation.
            ImageDecoder.Source src = ImageDecoder.createSource(f);
            return ImageDecoder.decodeBitmap(src, (decoder, info, source) -> {
                int w = info.getSize().getWidth(), h = info.getSize().getHeight();
                float s = Math.min(1f, (float) max / Math.max(1, Math.max(w, h)));
                decoder.setTargetSize(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
                decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
            });
        }
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(f.getPath(), o);
        if (o.outWidth <= 0 || o.outHeight <= 0) return null;
        int sample = 1;
        while (Math.max(o.outWidth, o.outHeight) / (sample * 2) >= max) sample *= 2;
        BitmapFactory.Options d = new BitmapFactory.Options();
        d.inSampleSize = sample;
        Bitmap b = BitmapFactory.decodeFile(f.getPath(), d);
        if (b == null) return null;
        int deg = 0;
        try {
            int or = new ExifInterface(f.getPath()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            deg = or == ExifInterface.ORIENTATION_ROTATE_90 ? 90 : or == ExifInterface.ORIENTATION_ROTATE_180 ? 180 : or == ExifInterface.ORIENTATION_ROTATE_270 ? 270 : 0;
        } catch (IOException ignored) {}
        return fit(b, max, deg);
    }

    private static Bitmap videoFrame(File f, int max) throws IOException {
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(f.getPath());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                Bitmap b = r.getScaledFrameAtTime(500_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, max, max);
                if (b != null) return b;
            }
            Bitmap b = r.getFrameAtTime(500_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
            return b == null ? null : fit(b, max, 0);
        } finally {
            r.release();
        }
    }

    /** Scales a bitmap to fit max (longest side) and turns it by deg; recycles the old one. */
    private static Bitmap fit(Bitmap b, int max, int deg) {
        float s = Math.min(1f, (float) max / Math.max(1, Math.max(b.getWidth(), b.getHeight())));
        if (s >= 1f && deg == 0) return b;
        Matrix mx = new Matrix();
        mx.postScale(s, s);
        if (deg != 0) mx.postRotate(deg);
        Bitmap out = Bitmap.createBitmap(b, 0, 0, b.getWidth(), b.getHeight(), mx, true);
        if (out != b) b.recycle();
        return out;
    }

    @PluginMethod
    public void remove(PluginCall call) {
        File f = received(call);
        if (f == null) return;
        //noinspection ResultOfMethodCallIgnored
        f.delete();
        File parent = f.getParentFile();
        String[] left = parent != null ? parent.list() : null;
        //noinspection ResultOfMethodCallIgnored
        if (parent != null && (left == null || left.length == 0)) parent.delete();
        call.resolve();
    }

    /** At app start: temporary and unfinished files (not the ones in use), and received files not in keep. */
    @PluginMethod
    public void cleanup(PluginCall call) {
        JSArray keepArr = call.getArray("keep", null);
        final Set<String> keep = new HashSet<>();
        boolean hasKeep = keepArr != null;
        if (keepArr != null) {
            JSONArray a = keepArr;
            for (int i = 0; i < a.length(); i++) {
                String ref = a.optString(i, "");
                int slash = ref.indexOf('/');
                if (slash > 0) keep.add(ref.substring(0, slash));
            }
        }
        io.execute(() -> {
            Set<String> inUse = new HashSet<>();
            for (Source s : sources.values()) if (s.temp != null) inUse.add(s.temp.getName());
            for (Sink s : sinks.values()) inUse.add(s.partial.getName());
            emptyDir(dir(false, TMP), inUse);
            emptyDir(dir(true, PARTIAL), inUse);
            if (hasKeep) emptyDir(dir(true, RECEIVED), keep);
            call.resolve();
        });
    }

    /** The received file named by call's "ref", or null after rejecting the call. */
    private File received(PluginCall call) {
        String ref = call.getString("ref", "");
        if (ref == null || !REF.matcher(ref).matches() || ref.contains("..")) {
            call.reject("This file is no longer on this phone.", "missing");
            return null;
        }
        try {
            File base = dir(true, RECEIVED).getCanonicalFile();
            File f = new File(base, ref).getCanonicalFile();
            if (!f.getPath().startsWith(base.getPath() + File.separator) || !f.isFile()) {
                call.reject("This file is no longer on this phone.", "missing");
                return null;
            }
            return f;
        } catch (IOException e) {
            call.reject("This file is no longer on this phone.", "missing");
            return null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        for (Integer h : new ArrayList<>(sources.keySet())) releaseSource(h);
        for (Sink s : sinks.values()) closeQuietly(s.raf);
        sinks.clear();
    }

    // ---- helpers ------------------------------------------------------------------------------------

    /** A whole number from the call: JS numbers arrive as Integer, Long or Double (PluginCall.getLong only takes Long). */
    private static Long num(PluginCall call, String name, Long fallback) {
        Object v = call.getData().opt(name);
        return v instanceof Number ? Long.valueOf(((Number) v).longValue()) : fallback;
    }

    private File dir(boolean keepAcrossCacheClears, String name) {
        File d = new File(keepAcrossCacheClears ? getContext().getFilesDir() : getContext().getCacheDir(), name);
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    private static void emptyDir(File d, Set<String> keep) {
        File[] list = d.listFiles();
        if (list == null) return;
        for (File f : list) {
            if (keep.contains(f.getName())) continue;
            deleteTree(f);
        }
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static void readFully(FileChannel ch, ByteBuffer buf, long offset) throws IOException {
        long pos = offset;
        while (buf.hasRemaining()) {
            int r = ch.read(buf, pos);
            if (r < 0) break;
            pos += r;
        }
    }

    private static void writeFully(FileChannel ch, ByteBuffer buf, long offset) throws IOException {
        long pos = offset;
        while (buf.hasRemaining()) pos += ch.write(buf, pos);
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] b = new byte[1024 * 1024];
        int n;
        while ((n = in.read(b)) > 0) out.write(b, 0, n);
        out.flush();
    }

    private static void closeQuietly(java.io.Closeable c) {
        try {
            if (c != null) c.close();
        } catch (IOException ignored) {}
    }

    private static String mimeFromName(String name) {
        int dot = name.lastIndexOf('.');
        if (dot >= 0) {
            String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
            if (m != null) return m;
        }
        return "application/octet-stream";
    }

    /** A file name that is safe on the phone's disk: no folders or odd characters, at most 200 bytes. */
    static String fsName(String name) {
        // Defence in depth (the web side already runs safeFileName): invisible direction and format
        // characters (U+202E and friends) go, and Windows-style trailing dots or spaces.
        String s = name == null ? "" : name.replaceAll("[\\p{Cf}\\u2028\\u2029]", "").replaceAll("[\\u0000-\\u001f\\u007f/\\\\:*?\"<>|]", "_").replaceAll("^\\.+", "_").trim().replaceAll("[. ]+$", "");
        if (s.isEmpty()) s = "file";
        if (s.getBytes(StandardCharsets.UTF_8).length <= 200) return s;
        int dot = s.lastIndexOf('.');
        String ext = dot > 0 && s.length() - dot <= 16 ? s.substring(dot) : "";
        String base = ext.isEmpty() ? s : s.substring(0, dot);
        while (!base.isEmpty() && (base + ext).getBytes(StandardCharsets.UTF_8).length > 200) base = base.substring(0, base.length() - 1);
        return base + ext;
    }

    private static File unique(File d, String name) {
        File f = new File(d, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; ; i++) {
            f = new File(d, base + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
    }
}
