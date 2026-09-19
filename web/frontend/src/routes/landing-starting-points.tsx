import { motion } from 'framer-motion'

export function StartingPointDiagram({ kind }: { kind: string }) {
  if (kind === 'device') return <svg className="terra-explorer-art" viewBox="0 0 560 230" fill="none" role="img" aria-label="一台设备接入网络并承接任务的示意图">
    <path d="M42 184H518" stroke="#456575" strokeOpacity=".35" />
    <rect x="42" y="54" width="168" height="108" rx="12" fill="#102433" stroke="#67e8d0" strokeOpacity=".75" /><rect x="58" y="70" width="136" height="73" rx="6" fill="#0a1b29" stroke="#67e8d0" strokeOpacity=".25" />
    <path d="M76 96h48m-48 14h76m-76 14h43" stroke="#67e8d0" strokeOpacity=".7" /><circle cx="177" cy="78" r="3" fill="#67e8d0" className="terra-light" /><text x="126" y="181" textAnchor="middle" fill="#b8d8d3" fontSize="14">工作站 / GPU</text>
    <path d="M210 108H316" stroke="#67e8d0" strokeOpacity=".6" strokeDasharray="5 7" /><motion.circle r="4" fill="#67e8d0" animate={{ cx: [214, 312], cy: [108, 108], opacity: [0, 1, 0] }} transition={{ duration: 2.2, repeat: Infinity, ease: 'linear' }} />
    <rect x="316" y="75" width="100" height="66" rx="12" fill="#142b38" stroke="#8ab4ec" strokeOpacity=".7" /><path d="M337 94h25m-25 11h25m-25 11h16" stroke="#8ab4ec" /><text x="366" y="161" textAnchor="middle" fill="#b4cbe2" fontSize="13">统一入口</text>
    <path d="M416 108H510" stroke="#c4b5fd" strokeOpacity=".6" strokeDasharray="5 7" /><motion.circle r="4" fill="#c4b5fd" animate={{ cx: [420, 506], cy: [108, 108], opacity: [0, 1, 0] }} transition={{ duration: 2.2, delay: .8, repeat: Infinity, ease: 'linear' }} />
    <rect x="458" y="82" width="58" height="52" rx="10" fill="#28233b" stroke="#c4b5fd" strokeOpacity=".7" /><text x="487" y="113" textAnchor="middle" fill="#e1d7ff" fontSize="12">任务</text><text x="280" y="42" textAnchor="middle" fill="#6f929f" fontSize="11" letterSpacing="2">CONNECT ONE DEVICE</text>
  </svg>

  if (kind === 'network') return <svg className="terra-explorer-art" viewBox="0 0 560 230" fill="none" role="img" aria-label="一组节点通过调度器协作完成任务的示意图">
    <path d="M280 115 116 48M280 115 116 182M280 115 444 48M280 115 444 182M280 115 280 26M280 115 280 204" stroke="#8ab4ec" strokeOpacity=".3" strokeDasharray="4 7" />
    {[[116, 48, 'GPU A'], [116, 182, 'GPU B'], [444, 48, 'GPU C'], [444, 182, 'GPU D'], [280, 26, 'CPU'], [280, 204, '存储']].map(([x, y, label], index) => <g key={label as string}><circle cx={x as number} cy={y as number} r="25" fill="#8ab4ec" fillOpacity=".08" stroke="#8ab4ec" strokeOpacity=".65" /><circle cx={x as number} cy={y as number} r="5" fill="#8ab4ec" className="terra-light" style={{ animationDelay: `${index * -.5}s` }} /><text x={x as number} y={(y as number) > 180 ? (y as number) - 34 : (y as number) + 43} textAnchor="middle" fill="#9eb9be" fontSize="11">{label}</text></g>)}
    <circle cx="280" cy="115" r="45" fill="#102c37" stroke="#8ab4ec" strokeWidth="1.5" /><circle cx="280" cy="115" r="30" fill="#173e46" stroke="#8ab4ec" strokeOpacity=".45" /><text x="280" y="111" textAnchor="middle" fill="#d5fff1" fontSize="14" fontWeight="600">调度</text><text x="280" y="129" textAnchor="middle" fill="#8ac8bd" fontSize="10">SCHEDULER</text>
    <motion.circle r="4" fill="#f6c889" animate={{ cx: [132, 264, 296, 428], cy: [48, 108, 122, 182], opacity: [0, 1, 1, 0] }} transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }} />
  </svg>

  return <svg className="terra-explorer-art" viewBox="0 0 560 230" fill="none" role="img" aria-label="一个想法通过运行环境连接算力并成为可访问服务的示意图">
    <path d="M82 115H478" stroke="#c4b5fd" strokeOpacity=".25" strokeDasharray="4 8" /><rect x="34" y="67" width="106" height="96" rx="14" fill="#28233b" stroke="#c4b5fd" strokeOpacity=".8" /><path d="M62 113c14-32 38-32 52 0-14 32-38 32-52 0Z" fill="#3a3156" stroke="#c4b5fd" strokeOpacity=".7" /><circle cx="88" cy="113" r="8" fill="#c4b5fd" fillOpacity=".5" /><text x="87" y="187" textAnchor="middle" fill="#d8cdf8" fontSize="13">模型 / Agent</text>
    <rect x="218" y="43" width="124" height="144" rx="14" fill="#102b37" stroke="#67e8d0" strokeOpacity=".75" /><rect x="238" y="67" width="84" height="26" rx="7" fill="#173b43" stroke="#67e8d0" strokeOpacity=".4" /><text x="280" y="85" textAnchor="middle" fill="#bdf4e2" fontSize="11">运行环境</text><rect x="238" y="104" width="84" height="26" rx="7" fill="#173b43" stroke="#67e8d0" strokeOpacity=".4" /><text x="280" y="122" textAnchor="middle" fill="#bdf4e2" fontSize="11">真实算力</text><path d="M251 153h58" stroke="#67e8d0" strokeOpacity=".65" /><text x="280" y="174" textAnchor="middle" fill="#81b9ae" fontSize="10">持续运行</text>
    <rect x="420" y="67" width="106" height="96" rx="14" fill="#172b3d" stroke="#8ab4ec" strokeOpacity=".8" /><path d="M444 104h56m-56 14h40m-40 14h29" stroke="#8ab4ec" /><text x="473" y="187" textAnchor="middle" fill="#c3d7ef" fontSize="13">可访问服务</text><motion.circle r="4" fill="#c4b5fd" animate={{ cx: [146, 410], cy: [115, 115], opacity: [0, 1, 0] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }} /><text x="280" y="22" textAnchor="middle" fill="#6f929f" fontSize="11" letterSpacing="2">IDEA → RUNTIME → SERVICE</text>
  </svg>
}
