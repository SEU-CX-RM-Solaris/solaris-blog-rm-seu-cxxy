---
category: "STM32 电控入门"
title: "STM32 电控入门 05 · ADC 采集与 RTC 实时时钟"
publishDate: "2026-11-08"
description: "ADC 读取旋钮电压与电源监控、NTC 测温的公式法与查表法换算，以及 RTC 实时时钟与日志时间戳。"
tags: ["STM32", "ADC", "RTC"]
---
# 模块四：ADC（例程 19~20）

## 5.1 知识点

- **12 位分辨率**：0~3.3V → 0~4095，LSB ≈ 0.8mV。
- 转换模式：**单次**（转一次停）/ **连续**（ContinuousConvMode=ENABLE，软件触发一次后不停转）/ **扫描**（多通道按 Rank 顺序）。
- **采样时间**：`ADC_SAMPLETIME_239CYCLES_5`（最长档）——外部阻抗高（如 10kΩ 分压）时必须用长采样保证精度。F103 ADC 时钟上限 14MHz（本套件 PCLK2/2=4MHz）。
- 电压换算：`V = raw × 3.3f / 4095`；归一化到控制量：`target = min + raw×(max-min)/4095`（旋钮给定值的通用套路）。

## 5.2 必学函数

```c
HAL_ADC_Init(&hadc1);                        // 配 Resolution(F1固定12位)/DataAlign/Scan/Continuous/ExternalTrig
HAL_ADC_ConfigChannel(&hadc1, &sConfig);     // sConfig: Channel/Rank/SamplingTime
HAL_ADC_Start(&hadc1);                       // 软件触发（连续模式下持续转换）
HAL_ADC_PollForConversion(&hadc1, 100);      // 等待转换完成（单次模式必须调；本套件连续模式省略了）
uint16_t raw = HAL_ADC_GetValue(&hadc1);     // 读 DR（右对齐 0~4095）
// 多通道进阶（套件未用但 RM 常用）：
HAL_ADC_Start_DMA(&hadc1, (uint32_t*)buf, len);  // 扫描结果由 DMA 搬进数组
```

## 5.3 NTC 测温换算（公式法 vs 查表法）

分压网络：3.3V ──10kΩ── PA4 节点 ──NTC── GND（NTC 在地侧）。
```c
// ① 电压→电阻：R_ntc = 10k × V/(3.3−V) = 10k × adc/(4096−adc)
float ADC2Resistance(uint32_t adc) { return (adc/(4096.0f - adc)) * 10000.0f; }
// ② 电阻→温度：B值公式 1/T = 1/T0 + (1/B)·ln(R/R0)
float R2T(float R) {
  float B=3950, R0=10000, T0=25;
  return 1.0/((1.0/B)*log(R/R0) + 1.0/(T0+273.15)) - 273.15;   // 开尔文→摄氏
}
```
工程替代：**查表法**（预存 R-T 表 + 插值）省 CPU（log/浮点贵，Cortex-M3 无 FPU 是软浮点）且可贴实测曲线。

**RM 关联**：电源/超级电容电压分压进 ADC 做过压报警与功率限制；NTC 测电机/驱动板温度做过温降速；多通道+DMA 是电流采样的基础形态。

---

# 模块六：RTC（例程 21）

- F103 的 RTC 本质是**备份域里的 32 位秒计数器**，LSE 32.768kHz 晶振分频到 1Hz 每秒+1；年月日是 HAL 软件记账的。主电源掉电靠 VBAT 纽扣电池继续走。
- 备份域访问三连：`HAL_PWR_EnableBkUpAccess()` → `__HAL_RCC_BKP_CLK_ENABLE()` → `__HAL_RCC_RTC_ENABLE()`。
- **必须先 GetTime 再 GetDate**（F1 的日期靠 GetTime 内部推算跨天，顺序错了日期可能停在昨天）。
- **BCD 编码**：每 4bit 存一个十进制位（59 存为 0x59）。打印技巧：`%02x` 直接把 BCD 打成十进制样子。
```c
HAL_RTC_GetTime(&hrtc, &sTime, RTC_FORMAT_BCD);
HAL_RTC_GetDate(&hrtc, &sDate, RTC_FORMAT_BCD);
sprintf(str, "20%02x-%02x-%02x %02x:%02x:%02x", sDate.Year, sDate.Month, sDate.Date,
        sTime.Hours, sTime.Minutes, sTime.Seconds);
```
- 时间保持：初始化函数里放开 `return;` 注释，就跳过 SetTime/SetDate 靠备份域记忆。
- RM 关联：日志时间戳（黑匣子定位故障时刻）；相对时序用 `HAL_GetTick()`，绝对时间用 RTC。

---

> 本文基于「波特律动」STM32 学习套件 V3.2 的例程源码与官方图文教程整理：[docs.keysking.com](http://docs.keysking.com/docs/stm32/example/) ｜ B站视频（UID 6100925）。
