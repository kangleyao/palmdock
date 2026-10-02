package com.agant.shell;

import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 页面事件代理（命名类，不用匿名内部类：本工具链的 d8 对匿名内部类有兼容性问题）。
 * 页面加载完成后，只读地从 localStorage 取出 agb_token 回交给 MainActivity，绝不修改页面内容。
 */
public final class PageClient extends WebViewClient {

    private final MainActivity host;

    PageClient(MainActivity host) {
        this.host = host;
    }

    @Override
    public void onPageFinished(WebView v, String url) {
        if (host != null) host.readToken(v); // 只读，不注入
    }
}
