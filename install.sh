#!/bin/bash
# System Monitor Beautiful - 安装脚本
# 用法: ./install.sh
# 注意: 请以普通用户身份运行，不要使用 sudo

set -e

# 检查 root 用户
if [ "$(id -u)" -eq 0 ]; then
    echo "========================================="
    echo "  错误: 请勿使用 root 或 sudo 运行此脚本"
    echo "========================================="
    echo ""
    echo "GNOME Shell 扩展必须安装在用户的本地目录下："
    echo "  ~/.local/share/gnome-shell/extensions/"
    echo ""
    echo "以 root 身份安装会导致扩展被安装到 root 用户的目录，"
    echo "当前用户将无法看到和使用该扩展。"
    echo ""
    echo "使用方法:"
    echo "  ./install.sh"
    exit 1
fi

# 获取当前用户名
CURRENT_USER=$(whoami)
EXTENSION_UUID="system-monitor-beautiful@${CURRENT_USER}"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "========================================="
echo "  System Monitor Beautiful 安装脚本"
echo "========================================="
echo ""

# 检查 GNOME Shell 版本
GNOME_VERSION=$(gnome-shell --version 2>/dev/null | grep -oP '[0-9]+' | head -1)
if [ -z "$GNOME_VERSION" ]; then
    echo "警告: 无法检测 GNOME Shell 版本"
else
    echo "检测到 GNOME Shell 版本: $GNOME_VERSION"
fi

# 创建扩展目录
echo "创建扩展目录: $EXTENSION_DIR"
mkdir -p "$EXTENSION_DIR"

# 复制文件
echo "复制扩展文件..."
cp "$SOURCE_DIR/extension.js" "$EXTENSION_DIR/"
cp "$SOURCE_DIR/stylesheet.css" "$EXTENSION_DIR/"
cp "$SOURCE_DIR/prefs.js" "$EXTENSION_DIR/"

# 动态替换 metadata.json 中的用户名为当前用户名
echo "生成 metadata.json (用户名: $CURRENT_USER)..."
sed "s/@user/@${CURRENT_USER}/g" "$SOURCE_DIR/metadata.json" > "$EXTENSION_DIR/metadata.json"

# 创建并编译 schema
echo "编译 GSettings Schema..."
mkdir -p "$EXTENSION_DIR/schemas"
cp "$SOURCE_DIR/schemas/org.gnome.shell.extensions.system-monitor-beautiful.gschema.xml" "$EXTENSION_DIR/schemas/"
glib-compile-schemas "$EXTENSION_DIR/schemas/" 2>/dev/null || true

# 安装 schema 到系统目录（需要 sudo）
echo "安装 Schema 到系统目录..."
if command -v sudo &>/dev/null; then
    sudo cp "$SOURCE_DIR/schemas/org.gnome.shell.extensions.system-monitor-beautiful.gschema.xml" /usr/share/glib-2.0/schemas/ 2>/dev/null || true
    sudo glib-compile-schemas /usr/share/glib-2.0/schemas/ 2>/dev/null || true
    echo "  Schema 已安装到系统目录"
else
    echo "  跳过系统 Schema 安装（需要 sudo 权限）"
fi

# 启用扩展
echo "启用扩展..."
gnome-extensions enable "$EXTENSION_UUID" 2>/dev/null || true

# 验证安装
echo ""
echo "验证扩展状态..."
if gnome-extensions list 2>/dev/null | grep -q "$EXTENSION_UUID"; then
    echo ""
    echo "========================================="
    echo "  安装成功！"
    echo "========================================="
    echo ""
    gnome-extensions info "$EXTENSION_UUID" 2>/dev/null
    echo ""
    
    # 检测会话类型并给出相应提示
    SESSION_TYPE=$(echo $XDG_SESSION_TYPE)
    echo "========================================="
    echo "  重启 GNOME Shell 以加载扩展"
    echo "========================================="
    echo ""
    if [ "$SESSION_TYPE" = "wayland" ]; then
        echo "[Wayland 会话] 请注销并重新登录"
        echo "  方法 1: 点击右上角系统菜单 → 注销 → 重新登录"
        echo "  方法 2: 运行命令: gnome-session-quit --logout --no-prompt"
    else
        echo "[X11 会话] 请按以下任一方式重启:"
        echo "  方法 1: 按 Alt+F2，输入 'r'，然后按 Enter（推荐）"
        echo "  方法 2: 运行命令: killall -3 gnome-shell"
        echo "  方法 3: 运行命令: dbus-send --session --dest=org.gnome.Shell --type=method_call /org/gnome/Shell org.gnome.Shell.Eval string:'global.restart()'"
    fi
else
    echo ""
    echo "========================================="
    echo "  警告: 扩展可能未被正确识别"
    echo "========================================="
    echo ""
    # 检测会话类型并给出相应提示
    SESSION_TYPE=$(echo $XDG_SESSION_TYPE)
    echo "请尝试以下步骤:"
    if [ "$SESSION_TYPE" = "wayland" ]; then
        echo "  1. 注销并重新登录（Wayland 会话）"
        echo "     - 点击右上角系统菜单 → 注销 → 重新登录"
        echo "     - 或运行: gnome-session-quit --logout --no-prompt"
    else
        echo "  1. 重启 GNOME Shell（X11 会话）"
        echo "     - 方法 1: 按 Alt+F2，输入 'r'，然后按 Enter"
        echo "     - 方法 2: 运行: killall -3 gnome-shell"
        echo "     - 方法 3: 运行: dbus-send --session --dest=org.gnome.Shell --type=method_call /org/gnome/Shell org.gnome.Shell.Eval string:'global.restart()'"
    fi
    echo "  2. 运行: gnome-extensions enable $EXTENSION_UUID"
    echo "  3. 使用 'Extensions' 应用查看扩展状态"
fi

# 显示会话类型信息
echo ""
echo "当前会话类型: $SESSION_TYPE"
if [ "$SESSION_TYPE" = "wayland" ]; then
    echo "（Wayland 会话无法热重启，需注销重新登录）"
else
    echo "（X11 会话支持热重启）"
fi
