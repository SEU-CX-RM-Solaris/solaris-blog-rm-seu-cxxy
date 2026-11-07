---
category: "STM32 电控入门"
title: "STM32 电控入门 04 · 定时器、PWM 与 DMA：单片机的心脏"
publishDate: "2026-11-08"
description: "定时器原理与 PSC/ARR 计算必背公式、PWM 驱动蜂鸣器/舵机/H 桥电机、WS2812 与 DMA 的价值、编码器接口与输入捕获——电机测速与 PID 反馈之源。"
tags: ["STM32", "PWM", "定时器", "DMA"]
---
# 模块三：定时器与 PWM（例程 11~18）★ 单片机的心脏

## 4.1 核心公式（必背）

```
定时器计数频率 f_tick = f_TIM / (PSC + 1)          // f_TIM = 72MHz
PWM 频率  f_PWM = f_tick / (ARR + 1) = f_TIM / (PSC+1) / (ARR+1)
占空比    duty = CCR / (ARR + 1)
定时中断周期 T = (PSC+1) × (ARR+1) / f_TIM
```
PWM1 模式（`TIM_OCMODE_PWM1`）：向上计数时 **CNT < CCR 输出高电平**。

## 4.2 五个 PWM 例程的配置数值（学会照着算）

| 例程 | 定时器/引脚 | PSC | ARR | PWM 频率 | 控制什么 |
|---|---|---|---|---|---|
| PWM_BUZZER | TIM4_CH4→PB9 | 71（→1MHz，1tick=1µs）| 运行时 500 / 334 | **2kHz / 3kHz** | 改 ARR 变调（音调=频率），CCR=ARR/5 定 20% 占空比（音量）|
| PWM_RGB | TIM3_CH1/2/3→PA6/PA7/PB0 | 71 | 99 | 10kHz | CCR 0~99 即 0~99% 占空比，线性渐变呼吸灯（10kHz>视觉暂留不闪）|
| PWM_Servo | TIM4_CH3→PB8 | 719（→100kHz，1tick=10µs）| 1999 | **50Hz（20ms 周期）**| CCR 50~250 = 0.5~2.5ms 脉宽 = 0°~180° |
| PWM_DRV8833 | TIM2_CH1/CH2→PA0/PA1 | 71 | 99 | 10kHz | 双通道选方向，CCR 控速 |
| WS2812 | TIM3_CH1→PB4（重映射）| **0**（1tick≈13.9ns）| 89 | **800kHz** | 每 PWM 周期=1 个数据位，CCR=66 编码"1"、=21 编码"0" |

**舵机角度换算（必背）**：
```
CCR = 50 + angle × 200 / 180     // 50→0°, 150→90°(中位), 250→180°
// 各品牌舵机端点脉宽不同，实际要标定；超程会堵转发热
// RM 摩擦轮用 PWM 无刷电调时协议同源：1000~2000µs 脉宽
```

**DRV8833 双 PWM 真值表（H 桥思想，通用）**：
| IN1 | IN2 | 电机 |
|---|---|---|
| PWM(d) | 0 | 正转，速度≈d |
| 0 | PWM(d) | 反转 |
| 1 | 1 | 刹车 |
| 0 | 0 | 滑行 |

## 4.3 必学函数与宏

```c
HAL_TIM_PWM_Start(&htim4, TIM_CHANNEL_4);   // 使能通道输出(CC4E)+启动计数器(CEN)
HAL_TIM_PWM_Stop(&htim4, TIM_CHANNEL_4);    // 关通道输出（电机失驱）
HAL_TIM_PWM_Start_DMA(&htim3, TIM_CHANNEL_1, (uint32_t*)buf, 340);
// 上面第三个函数：DMA 把 buf 里 340 个值依次搬进 CCR1 —— 波形由硬件自动播放

__HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_1, period);
// 宏：直接写 CCR1~CCR4 寄存器（三目运算符链，零函数开销，中断里可安全用）
__HAL_TIM_SET_AUTORELOAD(&htim4, 500);       // 宏：写 ARR + 同步 Init.Period
// 等价写法：htim4.Instance->ARR = 500;  （直接操作寄存器，Instance 就是外设基址指针）
```

**定时中断（基础定时器模式）**：
```c
HAL_TIM_Base_Start_IT(&htimX);               // 启动计数器+更新中断
void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim) {
  if (htim->Instance == TIM4) HAL_IncTick(); // FactoryDemo 用 TIM4 给 HAL 当 1ms 时基
}
```

## 4.4 WS2812：理解 DMA 价值的最佳例子

- 单线归零码：每位 1.25µs（800kHz），"1"=高 917ns，"0"=高 292ns，帧尾 125µs 低电平复位。
- 实现：ARR=89、PSC=0 → 800kHz PWM；**DMA 把预生成的 340 个 CCR 值按节奏搬进 CCR1**（前 100 个 0=复位码，之后每 24 个=1 颗灯的 RGB 24bit，MSB 先发，`(r<<i)&0x80` 逐位取值）。
- **为什么必须 DMA**：每 90 个时钟周期就要喂一次 CCR，CPU 干预必被中断打断导致时序错乱（容差仅 ±150ns）。DMA = 硬件零抖动"播放"波形。
- WS2812 驱动 API：`ws2812_set_rgb(id,r,g,b)` / `ws2812_set_all()` / `ws2812_update()`（刷新）/ `ws2812_gradient(steps,delay)`（线性插值渐变）/ `rainbow_effect()`（三路正弦相位差合成彩虹）。

## 4.5 编码器接口（Timer_RotaryEncoder ★★ PID 反馈之源）

```c
// TIM1 编码器模式：PA8=CH1(A相), PA9=CH2(B相)，EncoderMode=TIM_ENCODERMODE_TI1
HAL_TIM_Encoder_Init(&htim1, &sConfig);      // sConfig: EncoderMode/IC1Polarity/IC1Filter...
HAL_TIM_Encoder_Start(&htim1, TIM_CHANNEL_ALL);
__HAL_TIM_GET_COUNTER(&htim1)                 // 宏：读 CNT，硬件自动加/减，CPU 零参与
__HAL_TIM_SET_COUNTER(&htim1, 1000)           // 宏：写 CNT（预置避免回绕干扰观察）
```
- **正交编码器**：A/B 两相相差 90°，A 超前 B=正转。三种模式：`TI1`=x2（只数 A 相边沿，本例）、`TI2`=x2（只数 B 相）、`TI12`=**x4**（两相边沿全数，RM 标准做法，分辨率×4）。
- `IC1Filter=10/15`：数字滤波抗机械抖动。方向反了：交换 A/B 线或改极性。
- **16 位回绕处理（必会）**：`int16_t diff = (int16_t)(now - last);` 无符号减法+强转天然正确。
- RM 对应：M3508/GM6020 经电调 CAN 回传 8192 counts/圈（内部就是 x4 解码），对回传角度做差分求转速——**数学完全同构**。

## 4.6 输入捕获（Timer_UltraSonic）与秒表法（UltraSonic_Base）

**输入捕获原理**：引脚出现设定边沿时，**硬件自动把 CNT 当前值锁存进 CCRx**——时间戳精度 1 个计数，与 CPU 响应速度无关。测脉宽=两次捕获相减：
```c
__HAL_TIM_SET_CAPTUREPOLARITY(&htim1, TIM_CHANNEL_3, TIM_INPUTCHANNELPOLARITY_RISING);
HAL_TIM_IC_Start_IT(&htim1, TIM_CHANNEL_3);
// 回调里：
void HAL_TIM_IC_CaptureCallback(TIM_HandleTypeDef *htim) {
  if (htim == &htim1 && htim->Channel == HAL_TIM_ACTIVE_CHANNEL_3) {
    if (!echo_flag) { rising = HAL_TIM_ReadCapturedValue(htim, TIM_CHANNEL_3);
                      echo_flag = 1; 切极性为FALLING; }
    else            { falling = HAL_TIM_ReadCapturedValue(htim, TIM_CHANNEL_3); echo_flag = 0; 切回RISING; }
  }
}
// 距离：d(cm) = (falling - rising) × 0.017   // 声速340m/s=0.034cm/µs，往返÷2
```
**两种测距法对比**：

| | 输入捕获版 | 秒表轮询版（Base）|
|---|---|---|
| ECHO 脚 | TIM1_CH3 复用输入 | 普通 GPIO |
| 测宽 | 硬件锁存 CCR，精确 | `while(读GPIO)` 忙等 + TIM 计数 |
| CPU | 非阻塞 | 死循环占用，**ECHO 不来就卡死**（无超时，反例教材）|

TRIG 触发：GPIO 拉高→延时→拉低（例程用 `HAL_Delay(5)` 发 5ms；标准要 10µs，需 DWT 微秒延时）。**DWT 微秒延时**（softSPI 工程的 `dwt_stm32_delay.c`）：
```c
DWT_Delay_Init();   // 使能 CoreDebug->DEMCR.TRCENA 和 DWT->CTRL.CYCCNTENA（CPU周期计数器）
DWT_Delay_us(10);   // 用 CYCCNT 差值忙等，72MHz 下 1µs=72 个周期，无符号减法天然兼容回绕
```

---

# 模块七：DMA（贯穿 WS2812 / UART 例程）

- DMA = 硬件自动在内存和外设间搬数据，CPU 不参与。F103 只有 DMA1（7 通道）。
- 配置五要素：`Direction`（MEM_TO_PERIPH / PERIPH_TO_MEMORY）、`PeriphInc`（外设地址是否递增——写 CCR 时**不递增**）、`MemInc`（内存递增读数组）、`DataAlignment`（BYTE/HALFWORD/WORD，两端要一致）、`Mode`（NORMAL 搬完停 / CIRCULAR 循环）。
- 绑定：`__HAL_LINKDMA(timHandle, hdma[TIM_DMA_ID_CC1], hdmaXxx)` 把 DMA 句柄挂到外设句柄；中断里 `HAL_DMA_IRQHandler(&hdmaXxx)` 分发完成/半完成/错误事件。
- **使用哲学**：凡是"固定节奏、大批量、不容中断抖动"的数据搬运都该用 DMA——WS2812 波形、UART 收裁判系统（CIRCULAR 模式）、ADC 多通道扫描。

---

> 本文基于「波特律动」STM32 学习套件 V3.2 的例程源码与官方图文教程整理：[docs.keysking.com](http://docs.keysking.com/docs/stm32/example/) ｜ B站视频（UID 6100925）。
