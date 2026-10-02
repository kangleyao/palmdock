package com.agant.shell;

import android.content.Context;
import android.content.SharedPreferences;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * 应用私有偏好（SharedPreferences，MODE_PRIVATE）：
 * - 服务器地址、配对口令、开机自启开关、看护状态、已通知键集合；
 * - 口令只进私有存储，不进日志、不显示（界面只显示「已配对 / 未配对」）。
 */
public final class ShellPrefs {

    private static final String NAME = "agb_shell";
    private static final String KEY_BASE = "base";
    private static final String KEY_TOKEN = "agb_token";
    private static final String KEY_BOOT = "boot_enabled";
    private static final String KEY_STATUS = "status";
    private static final String KEY_STATUS_AT = "status_at";
    private static final String KEY_FIRED = "fired_keys";

    static final String DEFAULT_BASE = ""; // 首次使用必须由用户在设置页填服务器地址，不内置任何机器地址

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    static String base(Context c) {
        String b = sp(c).getString(KEY_BASE, DEFAULT_BASE);
        if (b == null || b.length() == 0) return DEFAULT_BASE;
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        return b;
    }

    static void setBase(Context c, String v) {
        if (v == null) return;
        sp(c).edit().putString(KEY_BASE, v.trim()).apply();
    }

    static String token(Context c) {
        return sp(c).getString(KEY_TOKEN, null);
    }

    static synchronized boolean saveToken(Context c, String t) {
        if (t == null || t.length() == 0) return false;
        String cur = sp(c).getString(KEY_TOKEN, null);
        if (t.equals(cur)) return false; // 没变化不重启服务
        sp(c).edit().putString(KEY_TOKEN, t).apply();
        return true;
    }

    static boolean bootEnabled(Context c) {
        return sp(c).getBoolean(KEY_BOOT, false);
    }

    static void setBootEnabled(Context c, boolean v) {
        sp(c).edit().putBoolean(KEY_BOOT, v).apply();
    }

    static void status(Context c, String s) {
        status(c, s, null);
    }

    static void status(Context c, String s, String detail) {
        sp(c).edit()
                .putString(KEY_STATUS, s)
                .putLong(KEY_STATUS_AT, System.currentTimeMillis())
                .apply();
    }

    static String status(Context c) {
        String s = sp(c).getString(KEY_STATUS, "未运行");
        long at = sp(c).getLong(KEY_STATUS_AT, 0);
        if (at > 0) {
            String t = new SimpleDateFormat("HH:mm", Locale.US).format(new Date(at));
            return s + "（" + t + "）";
        }
        return s;
    }

    static Set<String> firedKeys(Context c) {
        return new HashSet<>(sp(c).getStringSet(KEY_FIRED, new HashSet<String>()));
    }

    static void firedKeys(Context c, Set<String> v) {
        sp(c).edit().putStringSet(KEY_FIRED, new HashSet<>(v)).apply();
    }
}
