# System Monitor Beautiful

面向 **Ubuntu 22.04.5 LTS / GNOME Shell 42** 的轻量级顶栏系统监视扩展。

## 已实现功能

- 顶栏显示 **CPU 使用率**
- 顶栏显示 **内存使用率**
- 顶栏显示 **网络下载 / 上传速率**
- 自动选择默认路由网卡，找不到时回退到最活跃网卡
- 通过扩展菜单设置 **刷新间隔（1 / 2 / 3 / 5 / 10 秒）**
- 基于 `/proc/stat`、`/proc/meminfo`、`/proc/net/dev` 采样，低开销且精度适合常驻显示

## 项目结构

- `metadata.json`：扩展元数据
- `extension.js`：顶栏 UI、采样与菜单逻辑
- `prefs.js`：GNOME 扩展首选项界面（刷新间隔设置）
- `stylesheet.css`：样式
- `schemas/`：GSettings schema
- `install.sh`：一键安装脚本
- `uninstall.sh`：一键卸载脚本

## 安装方法

### 方法一：一键安装脚本（推荐）

> **注意**：请以**普通用户**身份运行此脚本，**不要使用 root 或 sudo**。
> 脚本会在需要安装系统 Schema 时自动请求 sudo 权限。

```bash
./install.sh
```

安装完成后，按 **Alt+F2**，输入 `r`，然后按 **Enter** 重启 GNOME Shell。

## 卸载方法

### 一键卸载（推荐）

```bash
./uninstall.sh
```

卸载后按 **Alt+F2**，输入 `r`，然后按 **Enter** 重启 GNOME Shell。

### 手动卸载

```bash
gnome-extensions disable system-monitor-beautiful@$USER
rm -rf ~/.local/share/gnome-shell/extensions/system-monitor-beautiful@$USER
```

### 方法二：手动安装

> `$USER` 会自动替换为当前用户名，无需手动修改。

1. 生成扩展元数据（将 `user` 替换为你的用户名）：

   ```bash
   sed "s/@user/@$(whoami)/g" metadata.json > "/tmp/metadata.json"
   ```

2. 将项目复制到 GNOME 扩展目录：

   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions/system-monitor-beautiful@$USER
   cp extension.js prefs.js stylesheet.css "/tmp/metadata.json" ~/.local/share/gnome-shell/extensions/system-monitor-beautiful@$USER/
   cp -r schemas ~/.local/share/gnome-shell/extensions/system-monitor-beautiful@$USER/
   ```

3. 编译 schema：

   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/system-monitor-beautiful@$USER/schemas/
   ```

4. 安装 schema 到系统目录（需要 sudo 权限）：

   ```bash
   sudo cp schemas/org.gnome.shell.extensions.system-monitor-beautiful.gschema.xml /usr/share/glib-2.0/schemas/
   sudo glib-compile-schemas /usr/share/glib-2.0/schemas/
   ```

5. 启用扩展：

   ```bash
   gnome-extensions enable system-monitor-beautiful@$USER
   ```

5. 重启 GNOME Shell：
   - **X11 会话**：按 **Alt+F2**，输入 `r`，然后按 **Enter**
   - **Wayland 会话**：注销并重新登录

## 验证安装

```bash
gnome-extensions info system-monitor-beautiful@$USER
```

应显示状态为 **ENABLED**。

## 建议验证项

- CPU 高负载时，顶栏 CPU 百分比能够在 1~2 个刷新周期内明显上升
- 大文件拷贝/下载时，网络上下行速率能持续变化，且无明显跳零抖动
- 打开多个应用后，内存百分比与 `free -h` / 系统监视器趋势一致
- 将刷新间隔切换到 1/5/10 秒后，设置能持久化生效

## 常见问题

### 安装后在扩展管理中看不到？

1. 确保 `metadata.json` 文件末尾有换行符
2. 运行 `gnome-extensions enable system-monitor-beautiful@$USER` 启用扩展
3. 重启 GNOME Shell（X11: Alt+F2 → r → Enter）

### 可以使用 root 用户安装吗？

**不可以。** 请以**普通用户**身份运行安装脚本。GNOME Shell 扩展必须安装在用户的本地目录（`~/.local/share/gnome-shell/extensions/`）下。
如果使用 `sudo ./install.sh`，扩展会被安装到 root 用户的目录下，当前用户无法看到和使用该扩展。

如不慎使用 root 安装，请删除 `/root/.local/share/gnome-shell/extensions/system-monitor-beautiful@<你的用户名>` 后以普通用户重新安装。

### 顶栏没有显示监控数据？

1. 确认扩展状态为 ENABLED：`gnome-extensions info system-monitor-beautiful@$USER`
2. 检查日志：`journalctl /usr/bin/gnome-shell -f`

## 重启 GNOME Shell 的方法

### X11 会话

| 方法 | 操作 | 说明 |
|------|------|------|
| **Alt+F2 快捷方式** | 按 `Alt+F2` → 输入 `r` → 按 `Enter` | 最常用，不关闭已打开的应用程序 |
| **kill 命令** | `killall -3 gnome-shell` | 发送 SIGQUIT 信号，效果等同于 Alt+F2 → r |
| **D-Bus 调用** | `dbus-send --session --dest=org.gnome.Shell --type=method_call /org/gnome/Shell org.gnome.Shell.Eval string:'global.restart()'` | 通过 D-Bus 调用 GNOME Shell 的 restart 方法 |

### Wayland 会话

Wayland 下**无法不注销重启 GNOME Shell**，因为显示服务器和会话是绑定的。

| 方法 | 操作 | 说明 |
|------|------|------|
| **注销并重新登录** | 点击右上角系统菜单 → 注销 → 重新登录 | 唯一方式，会关闭所有应用程序 |
| **命令行注销** | `gnome-session-quit --logout --no-prompt` | 直接注销，无确认 |

### 如何判断当前会话类型

```bash
echo $XDG_SESSION_TYPE
```

- 输出 `x11` → X11 会话
- 输出 `wayland` → Wayland 会话
