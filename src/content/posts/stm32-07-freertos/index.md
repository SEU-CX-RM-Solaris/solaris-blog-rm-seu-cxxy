---
category: "STM32 电控入门"
title: "STM32 电控入门 07 · FreeRTOS：从裸机到多任务"
publishDate: "2026-11-08"
description: "以 FactoryDemo 综合工程为例读懂 FreeRTOS：任务与队列 API、双时基、启动流程全貌，以及 RM 实战马上要用的 RTOS 概念。"
tags: ["STM32", "FreeRTOS", "多任务"]
---
## 9.1 架构

CubeMX 生成 **FreeRTOS + CMSIS-RTOS2 适配层**：应用调 `osXxx()` → CMSIS 层翻译 → FreeRTOS 内核。三层结构：**应用层（freertos.c）→ 设备驱动层（aht20/oled/ws2812.c）→ HAL 库层**——这就是 RM 电控代码的组织原型。

## 9.2 必学 API（本工程用到 4 个）

```c
osKernelInitialize();                                   // 内核数据初始化（建任务前）
osThreadNew(StartOledTask, NULL, &oledTask_attributes); // 创建任务，返回句柄
osKernelStart();                                        // 启动调度器，之后 main 的 while(1) 永远到不了
osDelay(270);                                           // 任务阻塞 270 tick（1 tick=1ms），让出 CPU

const osThreadAttr_t oledTask_attributes = {
  .name = "oledTask",
  .stack_size = 386 * 4,                    // 单位是字，×4 转字节；sprintf 吃栈要给大
  .priority = (osPriority_t)osPriorityNormal,
};
```
**任务函数模板（死循环+延时，绝不 return）**：
```c
void StartXxxTask(void *argument) {
  for (;;) {
    /* 干活 */
    osDelay(n);        // RTOS 的"睡眠"，区别于 HAL_Delay 的死等
  }
}
```
FactoryDemo 三个任务：oledTask（刷屏+温湿度，1544B 栈）/ rgbTask（WS2812 动效）/ keyTask（按键+串口心跳，优先级更低）——优先级规划思想：**实时控制 > 通信 > 显示灯效**。

## 9.3 双时基（读 RM 工程不迷路的关键）

用 RTOS 后：**SysTick 归 FreeRTOS**（1ms 调度心跳），**HAL 的毫秒时基挪到 TIM4**（`stm32f1xx_hal_timebase_tim.c` 的 `HAL_InitTick()` 配置，`HAL_TIM_PeriodElapsedCallback` 里 `HAL_IncTick()`）。另外：中断优先级数字 ≥5（`configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY`）才能安全调 FreeRTOS API。

## 9.4 启动流程全貌

```
HAL_Init → SystemClock_Config → MX_GPIO/DMA/TIM3/I2C1/USART2_Init
→ HAL_Delay(20) 等OLED上电 → OLED_Init → AHT20_Init
→ osKernelInitialize → 创建3任务 → osKernelStart（不返回）
```
**初始化顺序讲究**：DMA 时钟先于用它 TIM；依赖外设的器件初始化（OLED/AHT20）在调度器启动前做完。

## 9.5 未用到但必须认识的 RTOS 概念（RM 实战马上要）

- **队列** `osMessageQueueNew/Put/Get`：中断回调收数据 → 队列 → 控制任务取出解包（RM 数据流核心）
- **互斥锁** `osMutexNew/Acquire/Release`：多任务共享 CAN/SPI 总线、共享姿态结构体必须加（FactoryDemo 的 I2C 没加锁是靠时序错开的侥幸）
- **信号量** `osSemaphoreNew/Acquire/Release`：中断→任务的事件通知
- **定频控制**：`vTaskDelayUntil` 保证严格周期（`osDelay` 有累计误差），RM 控制环用它跑 1kHz

---

> 本文基于「波特律动」STM32 学习套件 V3.2 的例程源码与官方图文教程整理：[docs.keysking.com](http://docs.keysking.com/docs/stm32/example/) ｜ B站视频（UID 6100925）。
