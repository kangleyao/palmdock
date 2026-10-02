package com.agant.shell;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * 会话轮询与提醒：
 * - 每 15 秒由 WatchService 驱动一次：GET /api/sessions?limit=20（头 Authorization: Bearer <token>）；
 * - 首次拉取只建基线、绝不发通知；之后仅当 lastTurnStatus 从进行中变为 succeeded/failed/awaiting_answer 才通知；
 * - 同一 (sessionId, lastTurnAt, status) 只通知一次（集合持久化，重启不重播）；
 * - 网络失败 / 401 不误报，只记日志与「连接异常」状态；
 * - 标题 = 该会话首轮 message 前 20 字，取不到用 toolId；
 * - 完成态正文 = 详情里 lastTurn.result（JSON 字符串）按 summary → message → text → assistantText 取文本截 120 字，
 *   解析失败写「AI 完成了，点开看看」；提问态正文「AI 在等你回答」；点击通知打开该会话。
 */
public final class SessionPoller {

    private static final String TAG = "agb/poll";
    static final String CH_PERSIST = "agb_persist";
    static final String CH_ALERT = "agb_alert";
    private static final String[] READABLE_KEYS = {"summary", "message", "text", "assistantText"};
    private static final int MAX_BODY = 120;
    private static final int TITLE_CHARS = 20;
    private static final Set<String> LIVE;

    static {
        LIVE = new HashSet<>();
        LIVE.add("pending");
        LIVE.add("streaming");
        LIVE.add("awaiting_answer");
        LIVE.add("answered");
    }

    private final Context ctx;
    private final Set<String> fired = new HashSet<>();
    private Map<String, String> baseline = null;

    SessionPoller(Context context) {
        this.ctx = context.getApplicationContext();
        fired.addAll(ShellPrefs.firedKeys(this.ctx));
    }

    static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel persist = new NotificationChannel(CH_PERSIST, "看护状态", NotificationManager.IMPORTANCE_LOW);
        persist.setDescription("常驻一条静默状态，表示看护在运行");
        NotificationChannel alert = new NotificationChannel(CH_ALERT, "AI 提醒", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("AI 完成 / 出错 / 等待回答时响起");
        nm.createNotificationChannel(persist);
        nm.createNotificationChannel(alert);
    }

    static Notification.Builder newBuilder(Context c, String channel) {
        if (Build.VERSION.SDK_INT >= 26) return new Notification.Builder(c, channel);
        return new Notification.Builder(c); // 24-25 无渠道概念
    }

    void pollOnce() {
        String token = ShellPrefs.token(ctx);
        if (token == null || token.length() == 0) {
            ShellPrefs.status(ctx, "未配对");
            return;
        }
        String body = httpGet("/api/sessions?limit=20");
        if (body == null) return; // 失败已记日志与状态，不误报

        Map<String, Sess> now;
        try {
            now = parseList(body);
        } catch (Exception e) {
            Log.w(TAG, "列表解析失败: " + e);
            ShellPrefs.status(ctx, "连接异常");
            return;
        }

        if (baseline == null) {
            // 首次拉取只建基线：把当前状态当起点，绝不把历史当新事件播一遍
            baseline = new HashMap<>();
            for (Sess v : now.values()) baseline.put(v.id, v.status);
            Log.i(TAG, "基线建立: " + baseline.size() + " 个会话（本次不通知）");
            ShellPrefs.status(ctx, now.isEmpty() ? "正常（暂无会话）" : "正常");
            return;
        }

        for (Sess v : now.values()) {
            String prev = baseline.get(v.id);
            if (prev == null) continue; // 新出现的会话：未观察到进行过程，保守不通知
            if ("succeeded".equals(v.status) && LIVE.contains(prev)) {
                fire(v, false, "AI 完成了");
            } else if ("failed".equals(v.status) && LIVE.contains(prev)) {
                fire(v, false, "AI 出错了");
            } else if ("awaiting_answer".equals(v.status) && !"awaiting_answer".equals(prev)) {
                fire(v, true, "AI 在等你回答");
            }
        }

        Map<String, String> next = new HashMap<>();
        for (Sess v : now.values()) next.put(v.id, v.status);
        baseline = next;
        ShellPrefs.status(ctx, now.isEmpty() ? "正常（暂无会话）" : "正常");
    }

    static final class Sess {
        String id;
        String toolId;
        String status;
        String lastTurnAt;
    }

    private static Map<String, Sess> parseList(String body) throws Exception {
        JSONObject o = new JSONObject(body);
        JSONArray arr = o.getJSONArray("sessions");
        Map<String, Sess> m = new HashMap<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject s = arr.getJSONObject(i);
            Sess v = new Sess();
            v.id = s.optString("id", "");
            if (v.id.length() == 0) continue;
            v.toolId = s.optString("toolId", "");
            v.status = s.optString("lastTurnStatus", "");
            v.lastTurnAt = s.optString("lastTurnAt", "");
            m.put(v.id, v);
        }
        return m;
    }

    private void fire(Sess v, boolean awaiting, String kind) {
        String statusKey = awaiting ? "awaiting" : ("AI 完成了".equals(kind) ? "succeeded" : "failed");
        String key = v.id + "|" + (v.lastTurnAt == null ? "" : v.lastTurnAt) + "|" + statusKey;
        if (fired.contains(key)) return; // 同一 (sessionId, lastTurnAt, status) 只通知一次
        fired.add(key);
        ShellPrefs.firedKeys(ctx, fired);

        String title = (v.toolId == null || v.toolId.length() == 0) ? "掌坞" : v.toolId;
        String body = kind + "，点开看看";
        if (awaiting) body = "AI 在等你回答";

        JSONObject detail = null;
        try {
            detail = httpGetJson("/api/sessions/" + URLEncoder.encode(v.id, "UTF-8"));
        } catch (Exception e) {
            Log.w(TAG, "详情失败: " + e.getMessage());
        }
        if (detail != null) {
            String t = detailTitle(detail, v.toolId);
            if (t != null) title = t;
            if (!awaiting) {
                String r = readableResult(detail);
                if (r != null) body = r;
            }
        }
        if (body.length() > MAX_BODY) body = body.substring(0, MAX_BODY);

        postAlert(ctx, title, body, v.id);
        Log.i(TAG, "通知: " + title + " / " + statusKey + " / " + v.id);
    }

    private static String detailTitle(JSONObject detail, String toolId) {
        try {
            JSONArray turns = detail.getJSONArray("turns");
            if (turns.length() > 0) {
                String m = turns.getJSONObject(0).optString("message", "");
                if (m.length() > 0) {
                    return m.length() > TITLE_CHARS ? m.substring(0, TITLE_CHARS) : m;
                }
            }
        } catch (Exception ignore) { }
        return (toolId == null || toolId.length() == 0) ? "掌坞" : toolId;
    }

    private static String readableResult(JSONObject detail) {
        try {
            JSONObject lt = detail.getJSONObject("lastTurn");
            Object ro = lt.opt("result");
            if (!(ro instanceof String)) return null;
            JSONObject o = new JSONObject((String) ro);
            for (String k : READABLE_KEYS) {
                Object val = o.opt(k);
                if (val instanceof String) {
                    String s = (String) val;
                    if (s.trim().length() > 0) return s;
                }
            }
        } catch (Exception ignore) { }
        return null;
    }

    static void postAlert(Context c, String title, String body, String sessionId) {
        ensureChannels(c);
        Notification n = newBuilder(c, CH_ALERT)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setPriority(Notification.PRIORITY_HIGH)   // <26 生效
                .setDefaults(Notification.DEFAULT_ALL)     // <26 出声+振动；26+ 走渠道 IMPORTANCE_HIGH
                .setContentIntent(openIntent(c, sessionId))
                .build();
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        int nid = (sessionId == null || sessionId.length() == 0) ? 7700 : (sessionId.hashCode() & 0x7fff);
        nm.notify(nid, n);
    }

    private static PendingIntent openIntent(Context c, String sessionId) {
        Intent i = new Intent(c, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (sessionId != null && sessionId.length() > 0) i.putExtra("session", sessionId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(c, sessionId == null ? 0 : sessionId.hashCode(), i, flags);
    }

    private String httpGet(String path) {
        String token = ShellPrefs.token(ctx);
        if (token == null || token.length() == 0) return null;
        HttpURLConnection conn = null;
        try {
            URL u = new URL(ShellPrefs.base(ctx) + path);
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Authorization", "Bearer " + token);
            int code = conn.getResponseCode();
            if (code == 401 || code == 403) {
                Log.w(TAG, "鉴权失败 " + code + "（不误报）");
                ShellPrefs.status(ctx, "连接异常");
                return null;
            }
            if (code < 200 || code >= 300) {
                Log.w(TAG, "HTTP " + code + "（不误报）");
                ShellPrefs.status(ctx, "连接异常");
                return null;
            }
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
            return new String(bo.toByteArray(), "UTF-8");
        } catch (Exception e) {
            Log.w(TAG, "网络失败: " + e.getClass().getSimpleName() + " " + e.getMessage());
            ShellPrefs.status(ctx, "连接异常");
            return null;
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignore) { }
            }
        }
    }

    private JSONObject httpGetJson(String path) throws Exception {
        String body = httpGet(path);
        if (body == null) throw new Exception("empty body");
        return new JSONObject(body);
    }
}
