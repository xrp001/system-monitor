#!/bin/bash
# System Monitor Beautiful - 卸载脚本
# 用法: ./uninstall.sh
# 注意: 请以普通用户身份运行

set -e

# 检查 root 用户
if [ "$(id -u)" -eq 0 ]; then
    echo "========================================="
    echo "  错误: 请勿使用 root 或 sudo 运行此脚本"
    echo "========================================="
    echo ""
    echo "GNOME Shell 扩展安装在用户本地目录下，"
    echo "请以普通用户身份运行此脚本。"
    echo ""
    echo "使用方法:"
    echo "  ./uninstall.sh"
    exit 1
fi

# 获取当前用户名
CURRENT_USER=$(whoami)
EXTENSION_UUID="system-monitor-beautiful@${CURRENT_USER}"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

echo "========================================="
echo "  System Monitor Beautiful 卸载脚本"
echo "========================================="
echo ""

# 检查扩展是否已安装
if [ ! -d "$EXTENSION_DIR" ]; then
    echo "未找到扩展: $EXTENSION_UUID"
    echo "扩展可能未安装或已被卸载。"
    exit 0
fi

# 禁用扩展
echo "禁用扩展..."
gnome-extensions disable "$EXTENSION_UUID" 2>/dev/null || true

# 删除扩展文件
echo "删除扩展文件: $EXTENSION_DIR"
rm -rf "$EXTENSION_DIR"

# 检测会话类型
SESSION_TYPE=$(echo $XDG_SESSION_TYPE)

# 验证卸载
if [ ! -d "$EXTENSION_DIR" ]; then
    echo ""
    echo "========================================="
    echo "  卸载成功！"
    echo "========================================="
    echo ""
    echo "扩展 $EXTENSION_UUID 已被删除。"
    echo ""
    echo "========================================="
    echo "  重启 GNOME Shell 以应用更改"
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
    echo "  警告: 卸载可能未完全成功"
    echo "========================================="
    echo ""
    echo "请手动删除: $EXTENSION_DIR"
fi