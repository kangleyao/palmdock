package com.agant.shell;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * 看护服务（前台服务）：
 * - START_STICKY、常驻低优先级静默通知（「正在盯着 AI 的进度」）、部分唤醒锁、onTaskRemoved 尽力自启；
 * - 每 15 秒拉取会话列表，状态迁移检测由 SessionPoller 负责；
 * - 首次拉取只建基线、绝不发通知；网络失败/401 不误报，只记日志与状态。
 * 注：轮询用方法引用而非常规匿名 Runnable（本工具链 d8 对匿名内部类不兼容）。
 */
public final class WatchService extends Service {

    private static final String TAG = "agb/watch";
    private static final int NOTIF_ID = 1;
    private static final long POLL_INTERVAL_MS = 15000L;

    private PowerManager.WakeLock wake;
    private HandlerThread thread;
    private Handler handler;
    private SessionPoller poller;

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, WatchService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception e) {
            Log.w("agb/watch", "启动看护服务失败: " + e);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        SessionPoller.ensureChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundCompat();
        if (wake == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) {
                wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "agb:watch");
                try { wake.acquire(); } catch (Exception e) { Log.w(TAG, "唤醒锁: " + e); }
            }
        }
        if (thread == null) {
            thread = new HandlerThread("agb-watch");
            thread.start();
            handler = new Handler(thread.getLooper());
            handler.post(this::onWatchTick);
        }
        Log.i(TAG, "看护服务已启动");
        return START_STICKY;
    }

    private void onWatchTick() {
        try {
            if (poller == null) poller = new SessionPoller(WatchService.this);
            poller.pollOnce();
        } catch (Throwable t) {
            Log.e(TAG, "轮询异常: " + t);
        }
        if (handler != null) handler.postDelayed(this::onWatchTick, POLL_INTERVAL_MS);
    }

    private void startForegroundCompat() {
        Notification.Builder b = SessionPoller.newBuilder(this, SessionPoller.CH_PERSIST);
        b.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(getString(R.string.app_name))
                .setContentText("正在盯着 AI 的进度")
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_LOW);
        Notification n = b.build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    @Override
    public void onDestroy() {
        if (handler != null) handler.removeCallbacks(this::onWatchTick);
        if (thread != null) {
            thread.quitSafely();
            thread = null;
            handler = null;
        }
        if (wake != null && wake.isHeld()) {
            try { wake.release(); } catch (Exception ignore) { }
            wake = null;
        }
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 用户划掉任务后尽力自启（配合 START_STICKY，尽力而为）
        try { start(this); } catch (Exception e) { Log.w(TAG, "自启失败: " + e); }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
