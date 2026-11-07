---
category: "STM32 电控入门"
title: "STM32 电控入门 00 · 全景图：26 个例程与学习路线"
publishDate: "2026-11-08"
description: "波特律动学习套件 V3.2 全部 26 个例程总览：GPIO、UART、PWM、ADC、I2C、RTOS 全外设地图，附 6~8 周学习路线、RoboMaster 对应场景与引脚速查。"
tags: ["STM32", "学习路线", "电控"]
---
## 全景图：26 个例程一览


> **写给谁**：会 C++ 的计算机大二学生，RoboMaster 算法组成员，零 STM32 基础，目标是"算法为主、电控也能上手"。
>
> **源码位置**：`学习套件 `3.例程源码/` 目录`
> **图文文档**：http://docs.keysking.com/docs/stm32/example/ ｜ **视频**：B站 6100925
>
> ⚠️ **编译前必读**：工程必须先拷贝到**全英文路径**下再打开，中文路径会导致编译失败。

---


| # | 工程 | 学什么 | 核心外设 | RoboMaster 对应场景 | 建议顺序 |
|---|------|--------|----------|---------------------|---------|
| 1 | GPIO_RGB_LED | 点灯（输出） | GPIO 输出 | 状态指示灯 | ★1 |
| 2 | GPIO_KEY | 读按键（输入）+ 消抖 | GPIO 输入 | 板载按键/急停/开关检测 | ★2 |
| 3 | GPIO_Relay | 继电器控制执行器 | GPIO | 电磁阀/摩擦轮电源/风扇 | ★3 |
| 4 | GPIO_TCRT5000 | 数字传感器读取 | GPIO 输入 | 哨兵巡线/卡弹检测 | 4 |
| 5 | GPIO_EXTI | **外部中断** | EXTI + NVIC | 编码器 Z 相、急停、事件响应 | ★5 |
| 6 | UART_ECHO | 串口回显（DMA+空闲中断） | USART2 + DMA | 调试口、裁判系统接收雏形 | ★6 |
| 7 | UART_RGB | 串口阻塞收发控制灯 | USART2 | 仅调试用 | 7 |
| 8 | UART_RGB_IT | 串口**中断**接收 | USART2 中断 | 大疆 DBUS 遥控器解析同构 | ★8 |
| 9 | UART_BLE_ECHO | 蓝牙透传回显 | USART3 + DMA | 无线调试链路 | 9 |
| 10 | UART_BLE_COMMAND | **环形缓冲+帧协议解析** | USART3 + DMA | **裁判系统/视觉上位机协议模板** | ★★10 |
| 11 | PWM_BUZZER | PWM 变频驱动蜂鸣器 | TIM4 | 提示音/报警音 | ★11 |
| 12 | PWM_RGB | PWM 三通道呼吸灯 | TIM3 | 灯效、理解占空比 | 12 |
| 13 | PWM_Servo | 50Hz 舵机控制 | TIM4 | 弹仓盖舵机、云台机构 | ★13 |
| 14 | PWM_DRV8833 | H 桥电机驱动 | TIM2 | 有刷电机调速（电调思想入门） | ★14 |
| 15 | WS2812 | 定时器+DMA 播放波形 | TIM3 + DMA1 | RM 灯条、理解 DMA 的意义 | ★15 |
| 16 | Timer_RotaryEncoder | **编码器接口模式** | TIM1 | **电机测速/位置反馈（PID 输入）** | ★★16 |
| 17 | Timer_UltraSonic | 输入捕获测脉宽 | TIM1 输入捕获 | 超声波避障、遥控器脉宽测量 | 17 |
| 18 | Timer_UltraSonic_Base | 定时器当秒表+GPIO 轮询 | TIM1 时基 | 微秒计时、反例教材 | 18 |
| 19 | ADC_Potentiometer | ADC 读电压 | ADC1 | 旋钮给定值、电源电压监控 | ★19 |
| 20 | ADC_NTC | ADC + 换算公式测温 | ADC1 | 电机/驱动板温度监控 | 20 |
| 21 | RTC | 实时时钟 | RTC + LSE | 日志时间戳 | 21 |
| 22 | I2C_AHT20 | **硬件 I2C 读传感器** | I2C1 | IMU 通信同构（MPU6050） | ★22 |
| 23 | I2C_OLED | I2C 驱动 OLED 屏 | I2C1 | 电控最重要的调试显示手段 | ★23 |
| 24 | I2C_Soft | **软件模拟 I2C** | GPIO 模拟 | 引脚不固定/硬件 I2C 有 bug 时的方案 | 24 |
| 25 | softSPI | 软件模拟 SPI | GPIO 模拟 | IMU(SPI)、Flash 存参数 | 25 |
| 26 | FactoryDemo | **FreeRTOS 多任务综合** | 全部 + RTOS | RM 电控板的典型架构雏形 | ★★26（压轴）|

**推荐学习顺序 = 表中序号**。带 ★ 的是必精读例程，★★ 是直接对应 RM 实战的模板。

---

## 学习路线图（建议 6~8 周，每天 1~2 小时）

| 阶段 | 内容 | 例程 | 完成自测标准 |
|---|---|---|---|
| **① 入门 1 周** | 装好 CubeIDE，跑通编译下载；理解工程结构、时钟、USER CODE 区 | GPIO_RGB_LED → GPIO_KEY → GPIO_Relay | 不看例程自己写出"按键消抖控制 LED" |
| **② 中断思维 3 天** | EXTI、NVIC、弱回调 | GPIO_EXTI → GPIO_TCRT5000 | 能画出"按键→回调"完整中断链路图；说出"中断要短"的原因 |
| **③ 串口 1.5 周** ★电控核心 | 三种收发方式、环形缓冲、帧协议 | UART_RGB → UART_RGB_IT → UART_ECHO → UART_BLE_COMMAND | 给 printf 加重定向；用环形缓冲自己写一版"帧头+长度+CRC"解析器 |
| **④ PWM/定时器 1.5 周** | PSC/ARR/CCR 计算、舵机/电机/编码器/输入捕获 | PWM_BUZZER → PWM_Servo → PWM_DRV8833 → PWM_RGB → Timer_RotaryEncoder → Timer_UltraSonic | 闭卷算出"50Hz 舵机要的 PSC/ARR"；解释编码器 x2/x4 区别和回绕差值 |
| **⑤ 模拟量与总线 1 周** | ADC 换算、I2C 双层驱动、OLED 调试 | ADC_Potentiometer → ADC_NTC → I2C_AHT20 → I2C_OLED → I2C_Soft → softSPI → RTC | OLED 上实时显示 ADC 读数；给任意新 I2C 传感器写驱动 |
| **⑥ 综合 1 周** ★★ | DMA、FreeRTOS、多任务架构 | WS2812 → FactoryDemo | 读懂 FactoryDemo 全部任务；说出队列/互斥锁该加在哪 |
| **⑦ 进阶（套件外）** | **CAN 总线**（RM 电机电调唯一通道）、C 板(STM32F407)、PID 实现、`vTaskDelayUntil` 定频 | 官方开发板 C 板用户手册 + RM 论坛开源框架 | 用 C 板通过 CAN 读到 M3508 转速并闭环 |

**给算法组的特别建议**：你的优势是算法/控制理论，学电控的最短路径是"把例程当外设 API 手册读"——不必抠每个寄存器，重点掌握**三层架构**（HAL→驱动→任务）和**数据流**（中断收数据→缓冲→任务处理→控制输出），这两样就是 RM 电控的全部骨架。套件里没有但 RM 必学的：**CAN**（`HAL_CAN_AddTxMessage`/`HAL_CAN_RxFifo0MsgPendingCallback`）、F407 的 FPU/DSP、标准 PID 工程（你有理论基础，缺的只是嵌入式载体）。

---

## 各例程引脚速查（同一块板）

| 外设 | 引脚 |
|---|---|
| LED 红/绿/蓝 | PB0 / PA7 / PA6（推挽输出）|
| 按键 KEY1/2/3 | PB12（外部上拉）/ PB13 / PB15（内部上拉，按下=低）|
| 继电器 | PB5 |
| TCRT5000 | PB14 |
| USART2（调试口）| PA2=TX, PA3=RX，115200 |
| USART3（蓝牙）| PB10=TX, PB11=RX，9600 |
| I2C1（OLED+AHT20）| PB6=SCL, PB7=SDA |
| 蜂鸣器 | PB9 = TIM4_CH4 |
| 舵机 | PB8 = TIM4_CH3 |
| 电机 DRV8833 | PA0=TIM2_CH1(IN1), PA1=TIM2_CH2(IN2) |
| WS2812 | PB4 = TIM3_CH1（部分重映射+SWJ 释放）|
| 编码器 | PA8=TIM1_CH1(A), PA9=TIM1_CH2(B) |
| 超声波 | PA11=TRIG(GPIO), PA10=TIM1_CH3 或 GPIO(ECHO) |
| ADC | PA4=ADC1_IN4(NTC), PA5=ADC1_IN5(电位器) |
| 软件 SPI | PA12=SCLK, PA15=MOSI, PB3=MISO, PB1=CS |

---

*生成依据：对套件全部 26 个工程的 main.c、外设初始化文件、自定义驱动（command/oled/font/aht20/ws2812/softSPI/i2c_soft/dwt_stm32_delay）及 HAL 库源码的逐行精读。个别例程与官方文档可能有出入处已按实际源码标注（如编码器为 TI1/x2 模式、超声波触发为 5ms 脉冲、套件未做 printf 重定向）。*

> 本文基于「波特律动」STM32 学习套件 V3.2 的例程源码与官方图文教程整理：[docs.keysking.com](http://docs.keysking.com/docs/stm32/example/) ｜ B站视频（UID 6100925）。
