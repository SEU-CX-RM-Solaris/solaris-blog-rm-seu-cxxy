---
category: "STM32 电控入门"
title: "STM32 电控入门 01 · 准备知识：工程结构、时钟树与嵌入式 C 模式"
publishDate: "2026-11-08"
description: "CubeMX 工程结构、main 函数固定骨架、时钟树速成、__weak 弱符号回调与嵌入式 C 常用模式（C++ 视角速查）——读任何例程之前先看这篇。"
tags: ["STM32", "CubeMX", "C 语言"]
---
# 开始之前：工程结构与运行框架

## 1.1 每个工程都是 CubeMX 生成的，结构完全一致

```
GPIO_KEY/                      ← 工程根目录（.ioc 是 CubeMX 配置文件，双击可重新图形化配置）
├── Core/
│   ├── Src/
│   │   ├── main.c             ← 【必读】主逻辑、SystemClock_Config、用户回调
│   │   ├── gpio.c / usart.c / tim.c / adc.c / i2c.c / dma.c / rtc.c
│   │   │                      ← 外设初始化：MX_xxx_Init() + HAL_xxx_MspInit()
│   │   ├── stm32f1xx_it.c     ← 【EXTI/UART 工程必读】中断服务函数
│   │   ├── stm32f1xx_hal_msp.c← 板级底层初始化（时钟/引脚/NVIC）
│   │   └── syscalls.c/sysmem.c/system_stm32f1xx.c ← 标准库支撑，不用管
│   └── Inc/                   ← 对应头文件 + main.h（引脚宏定义）
├── Drivers/STM32F1xx_HAL_Driver/  ← HAL 库源码（想深究函数实现时来查）
└── STM32F103C8TX_FLASH.ld     ← 链接脚本
```

## 1.2 main 函数固定骨架（所有工程一样）

```c
int main(void)
{
  HAL_Init();                 // ① HAL库初始化：Flash等待周期、NVIC优先级分组、启动1ms SysTick
  SystemClock_Config();       // ② 配置系统时钟（多数例程 HSI 8MHz；部分例程 HSE×9=72MHz）
  MX_GPIO_Init();             // ③ 各外设初始化 MX_xxx_Init()，顺序由依赖关系决定
  MX_USART2_UART_Init();
  /* USER CODE BEGIN 2 */     // ← 你自己的初始化代码只能写在 USER CODE 区内！
  /* USER CODE END 2 */
  while (1) { ... }           // ④ 主循环（裸机工程的业务逻辑全在这）
}
```

**三条铁律：**
1. 自写代码必须放在 `/* USER CODE BEGIN x */` 和 `/* USER CODE END x */` 之间，否则用 CubeMX 重新生成时会被覆盖。
2. `Error_Handler()` = `__disable_irq(); while(1);`——嵌入式没有异常机制，出错就停机留现场。
3. 任何 HAL 初始化函数返回 `HAL_StatusTypeDef`：`HAL_OK`(0)/`HAL_ERROR`(1)/`HAL_BUSY`(2)/`HAL_TIMEOUT`(3)，工程上应检查返回值（例程为了简洁常不检查）。

## 1.3 时钟树速成（看懂 PSC/ARR 计算的前提）

| 例程类型 | 时钟配置 | 结果 |
|---|---|---|
| GPIO/UART/ADC/RTC/部分 I2C | HSI 内部 8MHz，不开 PLL | SYSCLK = 8MHz（省事，够用）|
| PWM/定时器/WS2812/EXTI/OLED/FactoryDemo | **HSE 8MHz 晶振 → PLL ×9 → 72MHz** | SYSCLK = 72MHz（F103 满频）|

72MHz 配置下：AHB=72MHz → APB1=36MHz（I2C/USART2/TIM2~4 在这）→ **APB1 上的定时器自动×2 = 72MHz**；APB2=72MHz（GPIO/TIM1/ADC 在这）。

关键函数（FactoryDemo，其余工程同构）：
```c
HAL_RCC_OscConfig(&RCC_OscInitStruct);    // 配 HSE 开关、PLL 倍频系数(RCC_PLL_MUL9)
HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_2);
// 第二参数：主频>48MHz 时 Flash 取指需 2 个等待周期
```

## 1.4 `__weak` 弱符号回调 —— HAL 的"虚函数"（C++ 同学重点）

HAL 库为所有"库不知道用户要干什么"的事件预置了**弱符号空函数**：
```c
__weak void HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin) { }   // 库里的空实现
```
你在自己的文件里**定义同名函数**，链接器就会用你的版本覆盖它。等价于 C++ 的"基类虚函数 + 子类 override"，但是发生在链接层面。**整套 HAL 的中断/事件处理全靠这个机制**：`HAL_UART_RxCpltCallback`、`HAL_UARTEx_RxEventCallback`、`HAL_TIM_PeriodElapsedCallback`、`HAL_TIM_IC_CaptureCallback`……全部如此。

## 1.5 引脚宏（main.h）

CubeMX 为每个配置的引脚生成一对宏：
```c
#define KEY1_Pin        GPIO_PIN_12   // 位掩码：0x1000，第12位为1
#define KEY1_GPIO_Port  GPIOB         // 端口指针：本质是 GPIO_TypeDef*
// 用法：HAL_GPIO_ReadPin(KEY1_GPIO_Port, KEY1_Pin)
```
位掩码可用 `|` 组合一次操作多个脚——对 C++ 同学：把 `uint16_t` 当 `std::bitset` 用。

---

# 嵌入式 C 语言模式手册（C++ 视角速查）

| 模式 | 写法 | C++ 类比 | 出现位置 |
|---|---|---|---|
| `volatile` | `volatile uint8_t flag;` 中断和主循环共享的变量**必须加**（套件例程漏了，是教学警示）| `std::atomic` 的弱化版 | 所有中断例程 |
| 弱符号回调 | 重写 `__weak` 函数 | 虚函数 override | 全部 HAL 回调 |
| 句柄即对象 | `UART_HandleTypeDef huart2` 全局定义 + `.h` 里 `extern` | 全局单例对象，HAL 函数=成员函数（传 this）| 所有外设 |
| static 封装 | `static uint8_t buf[128];` 文件内私有 | private 成员 | command.c / oled.c / ws2812.c |
| 结构体+宏模拟多实例 | `SoftSPI_TypeDef SoftSPI1/2/3` | 类的多个实例 | softSPI |
| 出参用指针 | `AHT20_Read(float *T, float *H)` | C 没有引用返回的惯用法 | aht20.c |
| 位操作拼数据 | `(buf[1]<<12)\|(buf[2]<<4)\|(buf[3]>>4)`；`r<<16\|g<<8\|b` | bitset 手工版 | 所有传感器 |
| 回绕安全差值 | `(int16_t)(now - last)` 定宽无符号减法 | — | 编码器/捕获 |
| 环形缓冲 | 数组+读写索引+%SIZE，判满牺牲一格 | 有界队列 | command.c |
| 状态机 | switch-case / 标志位两态切换 | 状态模式 | 按键/捕获 |
| `extern "C"` | 头文件包裹，C++ 工程链接 C 库必需 | — | 所有 .h |
| const 进 Flash | `const uint8_t font[][36]` | — | font.c |
| `float` 字面量 | `4096.0f`、`3.3f` 防整型除法截断 | — | ADC 换算 |
| 中断要短 | 回调里只置标志/记时间戳/塞缓冲 | — | RM 铁律 |
| BCD | 每 4bit 一个十进制位，`%02x` 直显 | — | RTC |

---

> 本文基于「波特律动」STM32 学习套件 V3.2 的例程源码与官方图文教程整理：[docs.keysking.com](http://docs.keysking.com/docs/stm32/example/) ｜ B站视频（UID 6100925）。
