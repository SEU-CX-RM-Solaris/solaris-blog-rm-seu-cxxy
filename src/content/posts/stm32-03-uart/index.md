---
category: "STM32 电控入门"
title: "STM32 电控入门 03 · UART 串口：从调试口到帧协议解析"
publishDate: "2026-11-08"
description: "串口阻塞收发、中断接收、DMA + 空闲中断回显，以及环形缓冲 + 帧协议解析架构——电控第一优先级外设，可直接对接裁判系统与视觉上位机。"
tags: ["STM32", "UART", "DMA"]
---
## 3.1 知识点

**UART 配置结构体（背下来）**：
```c
UART_HandleTypeDef huart2;
huart2.Instance = USART2;                          // 绑定到哪个串口外设
huart2.Init.BaudRate = 115200;                     // 波特率
huart2.Init.WordLength = UART_WORDLENGTH_8B;       // 8 数据位
huart2.Init.StopBits = UART_STOPBITS_1;            // 1 停止位
huart2.Init.Parity = UART_PARITY_NONE;             // 无校验
huart2.Init.Mode = UART_MODE_TX_RX;                // 收发都开
huart2.Init.HwFlowCtl = UART_HWCONTROL_NONE;       // 无硬件流控
huart2.Init.OverSampling = UART_OVERSAMPLING_16;
HAL_UART_Init(&huart2);   // 内部自动回调 HAL_UART_MspInit() 配引脚/时钟/NVIC/DMA
```
"115200-8-N-1"：每字节占 1起始+8数据+1停止 = **10 bit** → 传输 1 字节 ≈ **86.8µs**；9600 波特率下 ≈ 1.04ms/字节。大疆 DBUS 遥控器是特殊的 **100000 波特率 + 偶校验**。

**三种收发方式对比（本套件全部覆盖）**：

| 方式 | 函数 | CPU 占用 | 适用 |
|---|---|---|---|
| 阻塞 | `HAL_UART_Transmit` / `HAL_UART_Receive` | 死等 | 仅调试打印 |
| 中断 | `HAL_UART_Transmit_IT` / `HAL_UART_Receive_IT` | 每字节进一次中断 | 定长帧（DBUS 18字节）|
| **DMA+空闲中断** | `HAL_UARTEx_ReceiveToIdle_DMA` + 回调 | 几乎为零 | **不定长帧（裁判系统/上位机）**|

**空闲中断（IDLE）原理**：RX 线上出现一个字节时间以上的连续高电平 = 对方停止发送 = 一帧结束。用它实现"任意长度接收"，是裁判系统/视觉协议解析的标准方案。

**printf 重定向**（套件没做，你迟早需要）：
```c
#include <stdio.h>
int __io_putchar(int ch) {                    // newlib 的 printf 逐字符调它
  HAL_UART_Transmit(&huart2, (uint8_t*)&ch, 1, 0xFFFF);
  return ch;
}
// syscalls.c 已有 weak 桩 _write → __io_putchar，实现这个即可
```

## 3.2 必学函数

| 函数 | 完整形式 | 返回 | 说明 |
|---|---|---|---|
| `HAL_UART_Init` | `HAL_UART_Init(&huart2)` | HAL_StatusTypeDef | 初始化（MspInit 自动配引脚）|
| `HAL_UART_Transmit` | `(UART_HandleTypeDef*, uint8_t *pData, uint16_t Size, uint32_t Timeout)` | HAL_StatusTypeDef | **阻塞**发送；Timeout=HAL_MAX_DELAY(0xFFFFFFFF) 表示死等 |
| `HAL_UART_Receive` | `(同上 4 参数)` | 同上 | **阻塞**接收，超时返回 HAL_TIMEOUT |
| `HAL_UART_Transmit_IT` | `(huart, pData, Size)` | 同上 | 中断发送，立即返回，发完触发 `HAL_UART_TxCpltCallback` |
| `HAL_UART_Receive_IT` | `(huart, pData, Size)` | 同上（HAL_BUSY=正在收）| 中断接收**指定字节数**，收满触发 `HAL_UART_RxCpltCallback`。**一次性**：回调里必须重新调用以继续接收！|
| `HAL_UARTEx_ReceiveToIdle_DMA` | `(huart, pData, Size)` | 同上 | DMA 接收+空闲中断，收满 Size 或总线空闲都触发回调 |
| `HAL_UART_Transmit_DMA` | `(huart, pData, Size)` | 同上 | DMA 发送，立即返回 |
| `__HAL_DMA_DISABLE_IT` | `__HAL_DMA_DISABLE_IT(huart2.hdmarx, DMA_IT_HT)` | — | 宏：关 DMA 半传输中断（HAL 默认半满也触发回调，通常要关）|

**三个关键回调（都在 USER CODE 区重写）**：
```c
// ① 定长中断接收（UART_RGB_IT / DBUS 模板）
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart) {
  if (huart->Instance == USART2) {
    /* 处理 rx_data */
    HAL_UART_Receive_IT(&huart2, rx_data, 2);   // ★重新注册，漏了这行串口就"聋了"
  }
}
// ② 不定长 DMA 接收（UART_ECHO / 裁判系统模板）
void HAL_UARTEx_RxEventCallback(UART_HandleTypeDef *huart, uint16_t Size) {
  if (huart->Instance == USART2) {
    /* Size = 本次实际收到的字节数 */
    HAL_UARTEx_ReceiveToIdle_DMA(&huart2, rx_data, sizeof(rx_data));  // 重挂
    __HAL_DMA_DISABLE_IT(huart2.hdmarx, DMA_IT_HT);
  }
}
```
中断链路：`USART2_IRQHandler`（it.c）→ `HAL_UART_IRQHandler`（判断 RXNE/IDLE 标志、清标志）→ 上述回调。

## 3.3 UART_BLE_COMMAND 的帧协议架构（★★ 直接抄去用）

帧格式：`[包头 0xAA][长度 len][数据 n 字节][校验和]`（len=整帧总长，校验=前 len-1 字节累加和）

`command.c` 的**环形缓冲**（生产者=中断回调，消费者=主循环）：
```c
static uint8_t buffer[128];            // 静态环形缓冲
static uint8_t readIndex, writeIndex;  // 读/写指针，%BUFFER_SIZE 回绕
// 判空：读==写；判满：牺牲一格（写+1==读）；跨尾部写：两次 memcpy 拼接

uint8_t CommandBuffer_GetCommand(uint8_t *command) {  // 主循环切帧
  while (1) {
    if (长度 < 4) return 0;                    // 太短绝无整帧
    if (buffer[readIndex] != 0xAA) { 前移1; continue; }  // 找包头
    if (缓存 < len字段) return 0;              // 帧没收全，等
    if (校验和错误) { 前移1; continue; }        // 失败滑动1字节重扫
    提取整帧; 前移len; return len;              // 成功
  }
}
```
**架构精髓：中断里只 `CommandBuffer_Write()` 塞缓冲，解析放主循环**——中断要短，这直接对应 RM 裁判系统解析框架。升级到 RM 时：校验和 → CRC16 查表，包头 0xAA → 0xA5 五字节头，缓冲操作加临界区，共享变量加 `volatile`。

## 3.4 RM 对接速记

- 遥控器 DBUS = `HAL_UART_Receive_IT(&huart, buf, 18)` + 100000 波特率 + `UART_PARITY_EVEN`（对照 UART_RGB_IT 改）
- 裁判系统 115200-8-N-1，帧长随 cmd_id 变 → 必须 DMA+IDLE 不定长接收（对照 UART_BLE_COMMAND 改）
- 视觉上位机协议（你们算法组定义的帧）= 同一套环形缓冲模板，建议 CRC16 校验

---

> 本文基于「波特律动」STM32 学习套件 V3.2 的例程源码与官方图文教程整理：[docs.keysking.com](http://docs.keysking.com/docs/stm32/example/) ｜ B站视频（UID 6100925）。
