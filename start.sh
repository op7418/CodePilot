#!/bin/bash

# CodePilot 后台启动脚本

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$APP_DIR/app.log"
PID_FILE="$APP_DIR/app.pid"

# 显示菜单
show_menu() {
  clear
  echo "========================================"
  echo "      CodePilot 管理菜单"
  echo "========================================"
  echo ""
  
  # 检查状态（使用 ss 更可靠）
  local port_info=$(ss -tlnp 2>/dev/null | grep ":3000 ")
  local port_pid=$(echo "$port_info" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')
  
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "  当前状态: 运行中 (PID: $(cat "$PID_FILE"))"
  elif [ -n "$port_pid" ]; then
    echo "  当前状态: 端口被占用 (PID: $port_pid) - 异常"
  else
    echo "  当前状态: 未运行"
  fi
  
  echo ""
  echo "  [1] 启动服务"
  echo "  [2] 停止服务"
  echo "  [3] 重启服务"
  echo "  [4] 查看实时日志"
  echo "  [5] 查看状态"
  echo "  [6] 查看日志 (最后50行)"
  echo "  [0] 退出"
  echo ""
  echo "========================================"
}

# 启动服务
do_start() {
  # 先检查端口是否已被占用
  local port_info=$(ss -tlnp 2>/dev/null | grep ":3000 ")
  if [ -n "$port_info" ]; then
    local port_pid=$(echo "$port_info" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')
    echo "端口 3000 已被占用 (PID: $port_pid)"
    echo "请先运行 ./start.sh stop 停止服务"
    return 1
  fi
  
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "服务已在运行 (PID: $(cat "$PID_FILE"))"
    return 0
  fi
  
  cd "$APP_DIR" || exit 1
  
  # 启动服务并等待端口监听
  nohup npm run start > "$LOG_FILE" 2>&1 &
  local npm_pid=$!
  echo $npm_pid > "$PID_FILE"
  
  echo "正在启动服务..."
  
  # 等待端口监听（最多等待 30 秒，使用 ss 检测）
  local waited=0
  while [ $waited -lt 30 ]; do
    sleep 1
    waited=$((waited + 1))
    local check_info=$(ss -tlnp 2>/dev/null | grep ":3000 ")
    if [ -n "$check_info" ]; then
      local server_pid=$(echo "$check_info" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')
      echo "启动成功 (PID: $server_pid)"
      return 0
    fi
  done
  
  echo "启动超时，请检查日志: $LOG_FILE"
  return 1
}

# 停止服务
do_stop() {
  local stopped=0
  
  # 1. 先尝试停止 PID 文件中的进程及其子进程
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      # 杀掉整个进程组（包括子进程）
      kill -TERM -"$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null
      sleep 2
      # 如果进程还在，强制杀掉
      if kill -0 "$PID" 2>/dev/null; then
        kill -9 -"$PID" 2>/dev/null || kill -9 "$PID" 2>/dev/null
      fi
      echo "已停止 (PID: $PID)"
      stopped=1
    fi
    rm -f "$PID_FILE"
  fi
  
  # 2. 强制清理占用端口 3000 的所有进程（使用 ss 更可靠）
  local port_pids=$(ss -tlnp 2>/dev/null | grep ":3000 " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u)
  if [ -n "$port_pids" ]; then
    echo "清理端口 3000 残留进程: $port_pids"
    for pid in $port_pids; do
      kill -9 "$pid" 2>/dev/null && echo "  已杀掉 PID: $pid"
    done
    sleep 1
    stopped=1
  fi
  
  # 3. 备用方式：使用 lsof
  local lsof_pids=$(lsof -ti:3000 2>/dev/null)
  if [ -n "$lsof_pids" ]; then
    echo "清理残留进程 (lsof): $lsof_pids"
    echo "$lsof_pids" | xargs kill -9 2>/dev/null
    sleep 1
    stopped=1
  fi
  
  if [ "$stopped" -eq 0 ]; then
    echo "服务未运行"
  fi
  
  # 最终确认
  if ss -tlnp 2>/dev/null | grep -q ":3000 "; then
    echo "警告: 端口 3000 仍被占用"
    ss -tlnp | grep ":3000 "
  else
    echo "端口 3000 已释放"
  fi
}

# 查看状态
do_status() {
  local has_pid=0
  local has_port=0
  
  # 检查 PID 文件
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    has_pid=1
    echo "PID 文件: 运行中 (PID: $(cat "$PID_FILE"))"
  else
    echo "PID 文件: 未运行"
    [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
  fi
  
  # 检查端口占用（使用 ss 更可靠）
  local port_info=$(ss -tlnp 2>/dev/null | grep ":3000 ")
  if [ -n "$port_info" ]; then
    has_port=1
    local port_pid=$(echo "$port_info" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')
    echo "端口 3000: 被占用 (PID: $port_pid)"
  else
    echo "端口 3000: 空闲"
  fi
  
  # 综合状态
  echo ""
  if [ "$has_pid" -eq 1 ] && [ "$has_port" -eq 1 ]; then
    echo ">>> 服务正常运行"
  elif [ "$has_pid" -eq 0 ] && [ "$has_port" -eq 1 ]; then
    echo ">>> 异常: 端口被占用但 PID 文件不存在"
    echo ">>> 建议: 运行 ./start.sh stop 清理残留进程"
  elif [ "$has_pid" -eq 1 ] && [ "$has_port" -eq 0 ]; then
    echo ">>> 异常: PID 存在但端口未监听"
  else
    echo ">>> 服务未运行"
  fi
}

# 查看日志
do_log() {
  tail -f "$LOG_FILE"
}

# 菜单模式
menu_mode() {
  while true; do
    show_menu
    read -p "请选择操作 [0-6]: " choice
    
    case $choice in
      1)
        echo ""
        do_start
        read -p "按回车键继续..."
        ;;
      2)
        echo ""
        do_stop
        read -p "按回车键继续..."
        ;;
      3)
        echo ""
        do_stop
        sleep 1
        do_start
        read -p "按回车键继续..."
        ;;
      4)
        echo ""
        echo "按 Ctrl+C 退出日志查看"
        do_log
        ;;
      5)
        echo ""
        do_status
        read -p "按回车键继续..."
        ;;
      6)
        echo ""
        if [ -f "$LOG_FILE" ]; then
          tail -n 50 "$LOG_FILE"
        else
          echo "暂无日志文件"
        fi
        read -p "按回车键继续..."
        ;;
      0)
        echo ""
        echo "再见！"
        exit 0
        ;;
      *)
        echo ""
        echo "无效选项"
        read -p "按回车键继续..."
        ;;
    esac
  done
}

# 命令行模式
case "${1:-menu}" in
  start)
    do_start
    ;;
  stop)
    do_stop
    ;;
  restart)
    do_stop
    sleep 1
    do_start
    ;;
  status)
    do_status
    ;;
  log)
    do_log
    ;;
  menu)
    menu_mode
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|log|menu}"
    echo ""
    echo "  start  - 后台启动服务"
    echo "  stop   - 停止服务"
    echo "  restart- 重启服务"
    echo "  status - 查看运行状态"
    echo "  log    - 查看实时日志"
    echo "  menu   - 显示交互菜单（默认）"
    ;;
esac
