package com.agant.shell;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Switch;
import android.widget.TextView;

/**
 * 设置界面（一屏）：服务器地址 / 测试通知 / 通知权限 / 电池优化 / 开机自启 / 配对与看护状态。
 * 只显示「已配对 / 未配对」，绝不显示口令本身。
 */
public final class SettingsActivity extends Activity {

    private EditText baseEdit;
    private TextView tvPair;
    private TextView tvWatch;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        baseEdit = findViewById(R.id.edit_base);
        baseEdit.setText(ShellPrefs.base(this));

        Button btnTest = findViewById(R.id.btn_test_notify);
        btnTest.setOnClickListener(v -> SessionPoller.postAlert(SettingsActivity.this,
                "掌坞", "测试通知：看到这条，提醒通道是通的", null));

        Button btnPerm = findViewById(R.id.btn_notify_perm);
        btnPerm.setOnClickListener(v -> {
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1);
            } else {
                tvWatch.setText("看护状态：Android 13 以下无需运行时请求");
            }
        });

        Button btnBattery = findViewById(R.id.btn_battery);
        btnBattery.setOnClickListener(v -> {
            try {
                startActivity(new android.content.Intent(
                        android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        android.net.Uri.parse("package:" + getPackageName())));
            } catch (Exception e) {
                tvWatch.setText("看护状态：无法打开电池优化设置");
            }
        });

        Switch swBoot = findViewById(R.id.sw_boot);
        swBoot.setChecked(ShellPrefs.bootEnabled(this));
        swBoot.setOnCheckedChangeListener((button, isChecked) -> ShellPrefs.setBootEnabled(SettingsActivity.this, isChecked));

        tvPair = findViewById(R.id.tv_pair);
        tvWatch = findViewById(R.id.tv_watch);
        refreshStatus();
    }

    @Override
    protected void onPause() {
        super.onPause();
        String b = baseEdit.getText().toString().trim();
        if (b.length() > 0) ShellPrefs.setBase(this, b);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshStatus();
    }

    private void refreshStatus() {
        tvPair.setText("配对状态：" + (ShellPrefs.token(this) != null ? "已配对" : "未配对"));
        tvWatch.setText("看护状态：" + ShellPrefs.status(this));
    }
}
