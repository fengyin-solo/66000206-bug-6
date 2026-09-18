import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
import type { Device, Alarm, AlarmLevel, ModbusRegister } from '../types'

const STORAGE_KEY = 'modbus-monitor-state-v2'
const HISTORY_LIMIT = 100
const ALARM_LIMIT = 200

// 各模拟量点位的越限阈值（仅在越过上限时产生告警）
const THRESHOLDS: Record<string, { warning: number; critical: number }> = {
  温度: { warning: 28, critical: 30 },
  湿度: { warning: 75, critical: 85 },
  管道压力: { warning: 5, critical: 7 },
  差压: { warning: 0.5, critical: 0.8 },
  转速: { warning: 1600, critical: 1800 },
  电流: { warning: 18, critical: 22 },
  瞬时流量: { warning: 200, critical: 240 },
}

function levelOf(name: string, value: number): AlarmLevel | null {
  const t = THRESHOLDS[name]
  if (!t) return null
  if (value >= t.critical) return 'critical'
  if (value >= t.warning) return 'warning'
  return null
}

const LEVEL_RANK: Record<AlarmLevel, number> = { info: 0, warning: 1, critical: 2 }

let seq = 0
function nextAlarmId(): string {
  seq += 1
  // 同一毫秒内可能产生多条，用自增序号加随机后缀保证全局唯一
  return `a_${Date.now()}_${seq}_${Math.random().toString(36).slice(2, 7)}`
}

interface PersistedState {
  devices: Device[]
  alarms: Alarm[]
  historyData: Record<string, { time: number[]; values: number[] }>
  pollInterval: number
  selectedDeviceId: string | null
  isPolling: boolean
  activeLevels: Record<string, AlarmLevel>
  archivedCount: number
}

export const useModbusStore = defineStore('modbus', () => {
  const devices = ref<Device[]>([])
  const alarms = ref<Alarm[]>([])
  const historyData = ref<Record<string, { time: number[]; values: number[] }>>({})
  const isPolling = ref(false)
  const pollInterval = ref(1000)
  const selectedDevice = ref<Device | null>(null)
  // 每个点位当前正在持续的越限级别（无越限则不存在）
  const activeLevels = ref<Record<string, AlarmLevel>>({})
  // 因容量上限被归档清理的记录条数，用于页面提示
  const archivedCount = ref(0)

  const criticalAlarms = computed(() => alarms.value.filter(a => a.level === 'critical' && !a.acknowledged))
  const onlineDevices = computed(() => devices.value.filter(d => d.online))

  function defaultDevices(): Device[] {
    const now = Date.now()
    return [
      {
        id: 'dev1', name: '温湿度传感器-A区', ip: '192.168.1.101', port: 502, slaveId: 1, online: true,
        registers: [
          { address: 0, name: '温度', type: 'holding', value: 25.6, unit: '°C', updatedAt: now },
          { address: 1, name: '湿度', type: 'holding', value: 62.3, unit: '%RH', updatedAt: now },
          { address: 2, name: '露点', type: 'holding', value: 17.8, unit: '°C', updatedAt: now },
        ]
      },
      {
        id: 'dev2', name: '压力变送器-B区', ip: '192.168.1.102', port: 502, slaveId: 2, online: true,
        registers: [
          { address: 0, name: '管道压力', type: 'holding', value: 3.45, unit: 'MPa', updatedAt: now },
          { address: 1, name: '差压', type: 'holding', value: 0.12, unit: 'kPa', updatedAt: now },
        ]
      },
      {
        id: 'dev3', name: '电机控制器-C区', ip: '192.168.1.103', port: 502, slaveId: 3, online: false,
        registers: [
          { address: 0, name: '转速', type: 'holding', value: 1480, unit: 'RPM', updatedAt: now },
          { address: 1, name: '电流', type: 'holding', value: 12.5, unit: 'A', updatedAt: now },
          { address: 2, name: '运行状态', type: 'coil', value: true, unit: '', updatedAt: now },
        ]
      },
      {
        id: 'dev4', name: '流量计-D区', ip: '192.168.1.104', port: 502, slaveId: 4, online: true,
        registers: [
          { address: 0, name: '瞬时流量', type: 'holding', value: 156.7, unit: 'L/min', updatedAt: now },
          { address: 1, name: '累计流量', type: 'holding', value: 98234, unit: 'L', updatedAt: now },
        ]
      },
    ]
  }

  // 边沿判定：仅在"新越限"或"级别升高"（warning→critical）时产生一条记录，
  // 持续偏高与级别降低都不重复产生。
  function evaluateAlarm(dev: Device, reg: ModbusRegister) {
    const key = `${dev.id}_${reg.address}`
    const current = typeof reg.value === 'number' ? levelOf(reg.name, reg.value) : null
    const previous = activeLevels.value[key]

    if (!current) {
      delete activeLevels.value[key]
      return
    }
    if (previous && LEVEL_RANK[current] <= LEVEL_RANK[previous]) return
    activeLevels.value[key] = current

    alarms.value.unshift({
      id: nextAlarmId(),
      deviceId: dev.id,
      register: reg.name,
      message: `${dev.name} ${reg.name}超限: ${reg.value}${reg.unit}`,
      level: current,
      timestamp: Date.now(),
      acknowledged: false,
    })
  }

  // 容量控制：未确认的严重记录绝不丢弃；容量不够时只按"最旧优先"
  // 归档其余记录（已确认、warning、info），并累计计数供页面说明。
  function trimAlarms() {
    const need = alarms.value.length - ALARM_LIMIT
    if (need <= 0) return

    const candidates = alarms.value
      .filter(a => a.acknowledged || a.level !== 'critical')
      .sort((a, b) => a.timestamp - b.timestamp) // 最旧的先归档
    const dropped = new Set(candidates.slice(0, need).map(a => a.id))
    archivedCount.value += dropped.size
    alarms.value = alarms.value.filter(a => !dropped.has(a.id))
  }

  function pushHistory(key: string, time: number, value: number) {
    if (!historyData.value[key]) historyData.value[key] = { time: [], values: [] }
    const hd = historyData.value[key]
    hd.time.push(time)
    hd.values.push(value)
    if (hd.time.length > HISTORY_LIMIT) {
      hd.time.shift()
      hd.values.shift()
    }
  }

  function simulatePoll() {
    for (const dev of devices.value) {
      if (!dev.online) continue
      for (const reg of dev.registers) {
        const now = Date.now()
        reg.updatedAt = now
        if (typeof reg.value === 'boolean') {
          // 开关量（coil/discrete）只反映运行状态、没有数值，
          // 采集时同样要刷新状态与更新时间，否则界面永远停在初始值。
          if (Math.random() < 0.08) reg.value = !reg.value
        } else {
          const noise = (Math.random() - 0.5) * reg.value * 0.02
          reg.value = Math.round((reg.value + noise) * 100) / 100
          pushHistory(`${dev.id}_${reg.address}`, now, reg.value)
          evaluateAlarm(dev, reg)
        }
      }
    }
    trimAlarms()
    persist()
  }

  // 确认即从活动记录列表移除（不再保留为“已处理”行），id 唯一保证只影响这一条。
  function acknowledgeAlarm(id: string) {
    alarms.value = alarms.value.filter(a => a.id !== id)
    persist()
  }

  function toggleDevice(id: string) {
    const d = devices.value.find(d => d.id === id)
    if (d) d.online = !d.online
    persist()
  }

  function persist() {
    try {
      const state: PersistedState = {
        devices: devices.value,
        alarms: alarms.value,
        historyData: historyData.value,
        pollInterval: pollInterval.value,
        selectedDeviceId: selectedDevice.value?.id ?? null,
        isPolling: isPolling.value,
        activeLevels: activeLevels.value,
        archivedCount: archivedCount.value,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // 存储不可用（隐私模式/配额）时忽略，不影响实时采集
    }
  }

  function initMockDevices() {
    devices.value = defaultDevices()
    selectedDevice.value = devices.value[0]

    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as PersistedState
        if (Array.isArray(saved.devices) && saved.devices.length) {
          devices.value = saved.devices
          alarms.value = saved.alarms ?? []
          historyData.value = saved.historyData ?? {}
          activeLevels.value = saved.activeLevels ?? {}
          archivedCount.value = saved.archivedCount ?? 0
          pollInterval.value = saved.pollInterval || 1000
          selectedDevice.value = devices.value.find(d => d.id === saved.selectedDeviceId) ?? devices.value[0]
          isPolling.value = saved.isPolling ?? false
        }
      }
    } catch {
      // 数据损坏时回退为初始设备
    }
  }

  // 运行中调整轮询间隔后，让定时器按新间隔重启
  watch(pollInterval, () => persist())

  return {
    devices, alarms, historyData, isPolling, pollInterval, selectedDevice,
    activeLevels, archivedCount, HISTORY_LIMIT, ALARM_LIMIT,
    criticalAlarms, onlineDevices,
    initMockDevices, simulatePoll, acknowledgeAlarm, toggleDevice, persist,
  }
})
