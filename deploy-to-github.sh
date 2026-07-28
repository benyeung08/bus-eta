#!/bin/bash
# ============================================
#  一鍵部署到 GitHub Pages
#  使用方法：bash deploy-to-github.sh
# ============================================

set -e

echo ""
echo "🚌 香港巴士實時 ETA 系統 — GitHub Pages 部署腳本"
echo "=================================================="
echo ""

# 檢查 git
if ! command -v git &> /dev/null; then
    echo "❌ 未安裝 Git，請先安裝：https://git-scm.com/"
    exit 1
fi

# 獲取用戶名
read -p "📝 你的 GitHub 用戶名: " GITHUB_USER
if [ -z "$GITHUB_USER" ]; then
    echo "❌ 用戶名不能為空"
    exit 1
fi

# 獲取 repo 名
read -p "📝 Repository 名稱 (默認: bus-eta): " REPO_NAME
REPO_NAME=${REPO_NAME:-bus-eta}

# 獲取 repo 可見性
echo ""
echo "⚠️  重要：GitHub Pages 對免費帳號需要 Public repository"
read -p "📝 設為 Public? (y/n, 默認: y): " IS_PUBLIC
IS_PUBLIC=${IS_PUBLIC:-y}

# 檢查是否已登入 gh
if command -v gh &> /dev/null; then
    if ! gh auth status &> /dev/null; then
        echo ""
        echo "🔐 請先登入 GitHub CLI:"
        gh auth login
    fi
    
    echo ""
    echo "📦 創建 GitHub Repository..."
    if [ "$IS_PUBLIC" = "y" ]; then
        gh repo create "$REPO_NAME" --public --description "香港巴士實時ETA系統" || true
    else
        gh repo create "$REPO_NAME" --private --description "香港巴士實時ETA系統" || true
    fi
else
    echo ""
    echo "⚠️  未安裝 GitHub CLI (gh)，請手動創建 repository:"
    echo "   1. 前往 https://github.com/new"
    echo "   2. Repository name: $REPO_NAME"
    echo "   3. 設為 Public"
    echo "   4. 不要勾選 Initialize"
    echo ""
    read -p "   按 Enter 繼續..."
fi

# 初始化 git
echo ""
echo "📁 初始化 Git..."
git init
git add .
git commit -m "🚌 初始部署：香港巴士實時ETA系統"

# 添加 remote
echo ""
echo "🔗 添加 GitHub Remote..."
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$GITHUB_USER/$REPO_NAME.git"

# 推送
echo ""
echo "⬆️  推送到 GitHub..."
git branch -M main
git push -u origin main

echo ""
echo "=================================================="
echo "✅ 推送完成！"
echo ""
echo "下一步："
echo "  1. 前往 https://github.com/$GITHUB_USER/$REPO_NAME/settings/pages"
echo "  2. Source 選 'Deploy from a branch'"
echo "  3. Branch 選 'main' / '/ (root)'"
echo "  4. 點 Save"
echo "  5. 等待 1-2 分鐘"
echo ""
echo "🌐 你的網站將在："
echo "   https://$GITHUB_USER.github.io/$REPO_NAME/"
echo "=================================================="
echo ""
