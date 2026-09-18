import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
import type { Device, Alarm, ModbusRegister } from '../types'

const STORAGE_KEY = 'modbus-monitor-state-v1'
const MAX_ALARMS = 50
const MAX_HISTORY_POINTS = 100

/** 活动告警键：同一设备同一点位的连续越限始终归并为同一条 */
function alarmKey(deviceId: string, address: number) {
  return `${deviceId}_${address}`
}

/** 全局单调序号，保证即使同一毫秒内产生多条告警，编号也绝不重复 */
let alarmSeq = 0
function nextAlarmId() {
  alarmSeq += 1
  return `a_${Date.now()}_${alarmSeq.toString(36)}`
}

function makeMockDevices(): Device[] {
  const now = Date.now()
  return [
    {
      id: 'dev1', name: '温湿度传感器-A区', ip: '192.168.1.101', port: 502, slaveId: 1, online: true,
      registers: [
        { address: 0, name: '温度', type: 'holding', value: 25.6, unit: '°C', updatedAt: now, base: 26, step: 1.6, decimals: 1, highLimit: 28, criticalHigh: 32 },
        { address: 1, name: '湿度', type: 'holding', value: 62.3, unit: '%RH', updatedAt: now, base: 62, step: 4, decimals: 1, lowLimit: 30, highLimit: 75, criticalLow: 20, criticalHigh: 85 },
        { address: 2, name: '露点', type: 'holding', value: 17.8, unit: '°C', updatedAt: now, base: 18, step: 0.4, decimals: 1 },
      ]
    },
    {
      id: 'dev2', name: '压力变送器-B区', ip: '192.168.1.102', port: 502, slaveId: 2, online: true,
      registers: [
        { address: 0, name: '管道压力', type: 'holding', value: 3.45, unit: 'MPa', updatedAt: now, base: 3.5, step: 0.35, decimals: 2, highLimit: 4.0, criticalHigh: 4.6, lowLimit: 2.2, criticalLow: 1.8 },
        { address: 1, name: '差压', type: 'holding', value: 0.12, unit: 'kPa', updatedAt: now, base: 0.12, step: 0.03, decimals: 2 },
      ]
    },
    {
      id: 'dev3', name: '电机控制器-C区', ip: '192.168.1.103', port: 502, slaveId: 3, online: false,
      registers: [
        { address: 0, name: '转速', type: 'holding', value: 1480, unit: 'RPM', updatedAt: now, base: 1480, step: 25, decimals: 0 },
        { address: 1, name: '电流', type: 'holding', value: 12.5, unit: 'A', updatedAt: now, base: 12.5, step: 0.5, decimals: 1, highLimit: 16, criticalHigh: 18 },
        { address: 2, name: '运行状态', type: 'coil', value: true, unit: '', updatedAt: now },
      ]
    },
    {
      id: 'dev4', name: '流量计-D区', ip: '192.168.1.104', port: 502, slaveId: 4, online: true,
      registers: [
        { address: 0, name: '瞬时流量', type: 'holding', value: 156.7, unit: 'L/min', updatedAt: now, base: 156, step: 4, decimals: 1, lowLimit: 120, highLimit: 180 },
        { address: 1, name: '累计流量', type: 'holding', value: 98234, unit: 'L', updatedAt: now, base: 98234, step: 20, decimals: 0, monotonic: true },
      ]
    },
  ]
}

interface PersistedState {
  devices: Device[]
  alarms: Alarm[]
  historyData: Record<string, { time: number[]; values: number[] }>
  selectedDeviceId: string | null
  isPolling: boolean
  pollInterval: number
}

export const useModbusStore = defineStore('modbus', () => {
  const devices = ref<Device[]>([])
  const alarms = ref<Alarm[]>([])
  const historyData = ref<Record<string, { time: number[]; values: number[] }>>({})
  const isPolling = ref(false)
  const pollInterval = ref(1000)
  const selectedDevice = ref<Device | null>(null)

  // 活动（读数仍越限且未恢复）告警索引：key -> 告警对象
  const activeAlarmMap = new Map<string, Alarm>()
  // 达到容量上限而被自动淘汰的已处理记录数，用于页面提示
  const prunedCount = ref(0)

  const criticalAlarms = computed(() =>
    alarms.value.filter(a => a.level === 'critical' && !a.acknowledged && !a.recovered)
  )
  const onlineDevices = computed(() => devices.value.filter(d => d.online))

  // ---------------- 持久化 ----------------

  function persist() {
    if (!devices.value.length) return
    const state: PersistedState = {
      devices: devices.value,
      alarms: alarms.value,
      historyData: historyData.value,
      selectedDeviceId: selectedDevice.value?.id ?? null,
      isPolling: isPolling.value,
      pollInterval: pollInterval.value,
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // 存储不可用（隐私模式/配额）时静默降级，不影响实时监控
    }
  }

  function restore() {
    let state: PersistedState | null = null
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) state = JSON.parse(raw) as PersistedState
    } catch {
      state = null
    }

    if (state && Array.isArray(state.devices) && state.devices.length) {
      devices.value = state.devices
      alarms.value = Array.isArray(state.alarms) ? state.alarms : []
      historyData.value = state.historyData && typeof state.historyData === 'object' ? state.historyData : {}
      pollInterval.value = typeof state.pollInterval === 'number' ? state.pollInterval : 1000
      selectedDevice.value = devices.value.find(d => d.id === state!.selectedDeviceId) ?? devices.value[0]
      rebuildActiveAlarmMap()
      // 与旧版数据兼容：缺少新增字段的告警补上默认值
      for (const a of alarms.value) {
        a.lastTriggered ??= a.timestamp
        a.lastValue ??= 0
        a.triggerCount ??= 1
        a.recovered ??= false
      }
      isPolling.value = state.isPolling === true
    } else {
      initMockDevices()
    }
  }

  function rebuildActiveAlarmMap() {
    activeAlarmMap.clear()
    for (const a of alarms.value) {
      if (!a.recovered) activeAlarmMap.set(alarmKey(a.deviceId, a.address), a)
    }
  }

  function initMockDevices() {
    devices.value = makeMockDevices()
    alarms.value = []
    historyData.value = {}
    prunedCount.value = 0
    activeAlarmMap.clear()
    selectedDevice.value = devices.value[0]
    persist()
  }

  // ---------------- 采集模拟 ----------------

  /** 生成下一轮读数。布尔点位按概率翻转；数值点位围绕基准漂移，并保证至少变化一个最小刻度 */
  function nextRegisterValue(reg: ModbusRegister): number | boolean {
    if (typeof reg.value === 'boolean') {
      // 开关量：约每 6 轮有一次状态翻转机会
      return Math.random() < 1 / 6 ? !reg.value : reg.value
    }
    const decimals = reg.decimals ?? 2
    const minStep = Math.pow(10, -decimals) // 显示精度对应的最小刻度，避免变化被四舍五入吞掉
    const step = reg.step ?? Math.max(Math.abs(reg.value) * 0.01, minStep)
    let next: number
    if (reg.monotonic) {
      next = reg.value + Math.random() * step
    } else {
      const base = reg.base ?? reg.value
      // 向基准回归 + 随机游走，使越限能够发生也能自行恢复
      next = reg.value + (base - reg.value) * 0.08 + (Math.random() - 0.5) * 2 * step
      const moved = Math.abs(next - reg.value)
      if (moved < minStep) {
        next = reg.value + (Math.random() < 0.5 ? -minStep : minStep)
      }
    }
    const factor = Math.pow(10, decimals)
    return Math.round(next * factor) / factor
  }

  function evaluateLevel(reg: ModbusRegister, value: number): Alarm['level'] | null {
    if (typeof value !== 'number') return null
    if (reg.criticalHigh !== undefined && value > reg.criticalHigh) return 'critical'
    if (reg.criticalLow !== undefined && value < reg.criticalLow) return 'critical'
    if (reg.highLimit !== undefined && value > reg.highLimit) return 'warning'
    if (reg.lowLimit !== undefined && value < reg.lowLimit) return 'warning'
    return null
  }

  function alarmMessage(dev: Device, reg: ModbusRegister, value: number, level: Alarm['level']) {
    const dir =
      (reg.highLimit !== undefined && value > reg.highLimit) ||
      (reg.criticalHigh !== undefined && value > reg.criticalHigh)
        ? '偏高'
        : '偏低'
    return `${dev.name} ${reg.name}${dir}越限: ${value}${reg.unit}（${level === 'critical' ? '严重' : '预警'}）`
  }

  /** 容量控制：活动告警与未确认的严重告警受保护，只淘汰最早的已处理（已确认且已恢复）记录 */
  function pruneAlarms() {
    while (alarms.value.length > MAX_ALARMS) {
      let dropIdx = -1
      for (let i = alarms.value.length - 1; i >= 0; i--) {
        const a = alarms.value[i]
        if (a.acknowledged && a.recovered) { dropIdx = i; break }
      }
      if (dropIdx === -1) break // 其余均为需保留的活动/未确认记录，不再截断
      const [removed] = alarms.value.splice(dropIdx, 1)
      activeAlarmMap.delete(alarmKey(removed.deviceId, removed.address))
      prunedCount.value += 1
    }
  }

  function simulatePoll() {
    for (const dev of devices.value) {
      if (!dev.online) continue
      for (const reg of dev.registers) {
        reg.value = nextRegisterValue(reg)
        reg.updatedAt = Date.now()

        // 数值点位记录历史曲线；曲线键与告警键同为 设备id_地址，天然一一对应
        if (typeof reg.value === 'number') {
          const key = alarmKey(dev.id, reg.address)
          if (!historyData.value[key]) historyData.value[key] = { time: [], values: [] }
          historyData.value[key].time.push(reg.updatedAt)
          historyData.value[key].values.push(reg.value)
          if (historyData.value[key].time.length > MAX_HISTORY_POINTS) {
            historyData.value[key].time.shift()
            historyData.value[key].values.shift()
          }
        }

        const level = typeof reg.value === 'number' ? evaluateLevel(reg, reg.value) : null
        const key = alarmKey(dev.id, reg.address)
        const existing = activeAlarmMap.get(key)

        if (level) {
          const value = reg.value as number
          if (existing) {
            // 同一越限过程持续中：更新同一条记录，不再新增重复条目
            existing.level = level
            existing.lastValue = value
            existing.lastTriggered = reg.updatedAt
            existing.triggerCount += 1
            existing.message = alarmMessage(dev, reg, value, level)
            const idx = alarms.value.indexOf(existing)
            if (idx > 0) {
              alarms.value.splice(idx, 1)
              alarms.value.unshift(existing)
            }
          } else {
            const alarm: Alarm = {
              id: nextAlarmId(),
              deviceId: dev.id,
              deviceName: dev.name,
              register: reg.name,
              address: reg.address,
              message: alarmMessage(dev, reg, value, level),
              level,
              timestamp: reg.updatedAt,
              lastTriggered: reg.updatedAt,
              lastValue: value,
              triggerCount: 1,
              acknowledged: false,
              recovered: false,
            }
            alarms.value.unshift(alarm)
            activeAlarmMap.set(key, alarm)
          }
        } else if (existing) {
          // 读数回到正常范围：标记恢复并移出活动索引；记录保留待查看/确认
          existing.recovered = true
          existing.recoveredAt = reg.updatedAt
          activeAlarmMap.delete(key)
        }
      }
    }
    pruneAlarms()
    persist()
  }

  // ---------------- 告警操作 ----------------

  function acknowledgeAlarm(id: string) {
    const a = alarms.value.find(a => a.id === id)
    if (a) {
      a.acknowledged = true
      a.acknowledgedAt = Date.now()
      persist()
    }
  }

  function clearHandledAlarms() {
    alarms.value = alarms.value.filter(a => !(a.acknowledged && a.recovered))
    persist()
  }

  function toggleDevice(id: string) {
    const d = devices.value.find(d => d.id === id)
    if (d) {
      d.online = !d.online
      persist()
    }
  }

  function selectDevice(id: string) {
    selectedDevice.value = devices.value.find(d => d.id === id) ?? null
    persist()
  }

  function setPollInterval(ms: number) {
    pollInterval.value = ms
  }

  // 刷新/重载页面后恢复状态时，自动持久化调整（轮询定时器由组件层按 isPolling 重建）
  watch([isPolling, pollInterval], persist)

  return {
    devices, alarms, historyData, isPolling, pollInterval, selectedDevice,
    criticalAlarms, onlineDevices, prunedCount,
    initMockDevices, restore, persist,
    simulatePoll, acknowledgeAlarm, clearHandledAlarms, toggleDevice, selectDevice, setPollInterval,
  }
})
