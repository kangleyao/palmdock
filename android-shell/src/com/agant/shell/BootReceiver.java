package com.agant.shell;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * 开机自启：开机完成后，若用户打开了开关且已完成配对，则恢复看护服务。
 * 未配对不启动（没有口令轮询无意义）。
 */
public final class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        if (!ShellPrefs.bootEnabled(context)) return;
        if (ShellPrefs.token(context) == null) return;
        Log.i("agb/boot", "开机完成，恢复看护服务");
        try {
            Intent s = new Intent(context, WatchService.class);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(s);
            else context.startService(s);
        } catch (Exception e) {
            Log.w("agb/boot", "恢复失败: " + e);
        }
    }
}
