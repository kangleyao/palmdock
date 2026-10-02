package com.agant.shell;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.WebSettings;
import android.webkit.WebView;

import org.json.JSONTokener;

/**
 * 主界面：一个全屏 WebView，加载服务器页面。
 * 页面配对成功后（PageClient 只读 localStorage.agb_token），存入私有 SharedPreferences 并启动看护服务。
 * 通知点击带 sessionId 参数时直接打开 /session.html?id=<id>。
 * 注：全程不使用匿名内部类（本工具链 d8 对其不兼容），轮询用方法引用。
 */
public final class MainActivity extends Activity {

    private WebView web;
    private boolean pageLoaded;
    private String pendingSessionId;
    private final Handler tokenHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String sid = null;
        Intent it = getIntent();
        if (it != null) sid = it.getStringExtra("session");
        if (sid == null && savedInstanceState != null) sid = savedInstanceState.getString("session");
        pendingSessionId = sid;

        web = new WebView(this);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true); // 页面 localStorage（配对口令）所需
        ws.setSupportZoom(false);
        web.setWebViewClient(new PageClient(this));
        setContentView(web);
        loadPage();
        tokenHandler.postDelayed(this::onTokenTick, 15000L); // 方法引用 → invokedynamic，无匿名类
    }

    private void loadPage() {
        String base = ShellPrefs.base(this);
        if (base.length() == 0) {
            // 首次使用未填服务器地址：直达设置页，不加载半个 URL
            startActivity(new Intent(this, SettingsActivity.class));
            return;
        }
        pageLoaded = true;
        String url = base + "/session.html";
        String sid = pendingSessionId;
        if (sid != null && sid.length() > 0) {
            url = base + "/session.html?id=" + Uri.encode(sid);
        }
        web.loadUrl(url);
    }

    private void onTokenTick() {
        if (isDestroyed() || web == null) return; // 页面/Activity 已销毁就不再补读
        if (web != null) readToken(web);
        tokenHandler.postDelayed(this::onTokenTick, 15000L); // 兜底：配对发生在页面内时补读
    }

    void readToken(final WebView v) {
        v.evaluateJavascript("localStorage.getItem('agb_token')", result -> {
            if (result == null) return;
            String t;
            try {
                Object o = new JSONTokener(result).nextValue();
                t = o == null ? null : o.toString();
            } catch (Exception e) {
                t = null;
            }
            if (t == null || t.length() == 0) return; // 未配对，不动
            if (ShellPrefs.saveToken(MainActivity.this, t)) {
                WatchService.start(MainActivity.this);
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null) {
            String sid = intent.getStringExtra("session");
            if (sid != null && sid.length() > 0) {
                pendingSessionId = sid;
                loadPage();
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 从设置页回来时：若地址已填且页面尚未加载，则加载（仍未填则不跳转，避免来回循环）
        if (!pageLoaded && ShellPrefs.base(this).length() > 0) loadPage();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putString("session", pendingSessionId);
    }

    @Override
    protected void onDestroy() {
        tokenHandler.removeCallbacks(this::onTokenTick);
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); // 返回键走网页历史
        else super.onBackPressed();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "设置").setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) {
            startActivity(new Intent(this, SettingsActivity.class));
            return true;
        }
        return false;
    }
}
