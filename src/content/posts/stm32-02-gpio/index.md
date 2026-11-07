---
category: "STM32 电控入门"
title: "STM32 电控入门 02 · GPIO：从点灯到外部中断"
publishDate: "2026-11-08"
description: "GPIO 输出与输入、按键消抖、继电器与数字传感器读取、EXTI 外部中断：5 个例程带你完成单片机世界的 Hello World。"
tags: ["STM32", "GPIO", "中断"]
---
## 2.1 知识点

**GPIO_InitTypeDef 四个字段（必须背下来）：**

| 字段 | 常用取值 | 含义 |
|---|---|---|
| `Pin` | `GPIO_PIN_0`~`GPIO_PIN_15`，可 `\|` 组合 | 引脚位掩码 |
| `Mode` | `GPIO_MODE_OUTPUT_PP` 推挽输出 / `GPIO_MODE_OUTPUT_OD` 开漏输出 / `GPIO_MODE_INPUT` 浮空输入 / `GPIO_MODE_IT_RISING/FALLING/RISING_FALLING` 外部中断 | 工作模式 |
| `Pull` | `GPIO_NOPULL` / `GPIO_PULLUP` / `GPIO_PULLDOWN` | 上下拉（仅输入有意义）|
| `Speed` | `GPIO_SPEED_FREQ_LOW/MEDIUM/HIGH` | 输出翻转速度（LED 用 LOW 足够，WS2812/UART 用 HIGH）|

**F1 特有规则**：外设使用前必须先开总线时钟 `__HAL_RCC_GPIOA_CLK_ENABLE()`；I2C 引脚要 `GPIO_MODE_AF_OD`（复用开漏），UART TX 要 `GPIO_MODE_AF_PP`（复用推挽）。

**三种按键判断写法**（等价，都要认识）：
```c
if (HAL_GPIO_ReadPin(...) == GPIO_PIN_RESET)   // 显式比较
if (!HAL_GPIO_ReadPin(...))                    // 逻辑非（RESET=0）
if (HAL_GPIO_ReadPin(...))                     // 直接当布尔用（SET=1）
```

**按键消抖三段式（背下来）**：机械触点闭合瞬间会抖动几 ms：
```c
if (!HAL_GPIO_ReadPin(KEY_GPIO_Port, KEY_Pin)) {    // ① 检测到按下（低电平）
    HAL_Delay(50);                                   // ② 延时躲过抖动期
    if (!HAL_GPIO_ReadPin(KEY_GPIO_Port, KEY_Pin)) { // ③ 复读确认
        // 执行动作
        while (!HAL_GPIO_ReadPin(...));              // 等待松手，防止一次按键触发多次
    }
}
```
注意：`while` 等松手是**阻塞**的——这正是 EXTI 例程要解决的问题。

## 2.2 必学函数

| 函数 | 完整形式 | 返回 | 说明 |
|---|---|---|---|
| `HAL_GPIO_Init` | `HAL_GPIO_Init(GPIO_TypeDef *GPIOx, GPIO_InitTypeDef *GPIO_InitStruct)` | void | 按 InitStruct 配置一组引脚 |
| `HAL_GPIO_WritePin` | `HAL_GPIO_WritePin(GPIOx, uint16_t Pin, GPIO_PinState state)` | void | 写电平；底层写 BSRR 寄存器，**原子操作**。`GPIO_PIN_SET`=高，`GPIO_PIN_RESET`=低 |
| `HAL_GPIO_ReadPin` | `HAL_GPIO_ReadPin(GPIOx, uint16_t Pin)` | `GPIO_PinState` | 读电平；底层 `GPIOx->IDR & Pin` |
| `HAL_GPIO_TogglePin` | `HAL_GPIO_TogglePin(GPIOx, uint16_t Pin)` | void | 翻转电平 |
| `HAL_Delay` | `HAL_Delay(uint32_t ms)` | void | 阻塞延时；基于 SysTick 中断累计的 `uwTick`，**中断里禁用**（会死锁）|
| `HAL_GetTick` | `HAL_GetTick()` | uint32_t | 当前毫秒数，用于非阻塞计时 |
| `HAL_NVIC_SetPriority` | `HAL_NVIC_SetPriority(IRQn_Type IRQn, uint32_t PreemptPriority, uint32_t SubPriority)` | void | 抢占优先级数值越小越优先 |
| `HAL_NVIC_EnableIRQ` | `HAL_NVIC_EnableIRQ(IRQn_Type IRQn)` | void | 打开 NVIC 中断开关 |

**EXTI 专有：**
```c
// gpio.c 中：Mode 设为 GPIO_MODE_IT_FALLING 后，HAL 自动开 AFIO 时钟、
// 把 PB12 映射到 EXTI 线12（F1 规则：线号=引脚号）、置位 IMR、配触发沿
HAL_NVIC_SetPriority(EXTI15_10_IRQn, 0, 0);   // EXTI10~15 共用一个 NVIC 向量
HAL_NVIC_EnableIRQ(EXTI15_10_IRQn);

// stm32f1xx_it.c 中（CubeMX 生成）：
void EXTI15_10_IRQHandler(void) {
  HAL_GPIO_EXTI_IRQHandler(KEY1_Pin);   // 查 EXTI->PR 挂起标志→清标志→分发回调
}
// 用户重写（放 USER CODE 区）：
void HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin) {
  if (GPIO_Pin == KEY1_Pin) { /* 多条中断线靠参数区分 */ }
}
```

## 2.3 例程要点

- **GPIO_KEY**：三个按键演示三种处理——KEY1 电平跟随（按住灯亮）、KEY2/KEY3 消抖+翻转。KEY1 浮空依赖外部上拉，KEY2/KEY3 用内部上拉（松开=高，按下=低）。
- **GPIO_RGB_LED**：最简单的三路输出组合颜色（2³=8 种）。⚠️ 代码里三行都写 `GPIO_PIN_SET` 但注释有"点亮/熄灭"——上板改 SET/RESET 自己确认灯是高电平还是低电平点亮，是很好的第一个实验。
- **GPIO_Relay**：继电器=GPIO 驱动大功率设备的桥梁（RM 里对应电磁阀/风扇/电源总开关）。**上电先写确定的安全初始电平**（默认断开）是控制大电流的安全铁律。
- **GPIO_EXTI**：主循环完全空转也能响应按键。中断链路：下降沿 → EXTI 线12 挂起 → NVIC → `EXTI15_10_IRQHandler` → `HAL_GPIO_EXTI_IRQHandler`（清标志）→ 用户回调。⚠️ **中断服务要短**：回调里只置标志/记时间戳，处理放主循环——RM 电控铁律。
- **GPIO_TCRT5000**：红外反射模块经 LM393 比较器输出数字量（白/远=高，黑/近=低）。阈值由硬件电位器定，软件只读 0/1。哨兵 8 路灰度巡线就是它的数组扩展。

**易错点**：传感器"高/低代表什么"必须用注释或语义宏固化（`#define LINE_DETECTED 0`），这是嵌入式调试最容易忘的事。

---

> 本文基于「波特律动」STM32 学习套件 V3.2 的例程源码与官方图文教程整理：[docs.keysking.com](http://docs.keysking.com/docs/stm32/example/) ｜ B站视频（UID 6100925）。
