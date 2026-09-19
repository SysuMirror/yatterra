import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useInView } from 'framer-motion'

type Point = [number, number]

export function AnimatedScene({ children, className = '', label }: { children: ReactNode; className?: string; label: string }) {
  const scene = useRef<HTMLDivElement>(null)
  const inView = useInView(scene, { margin: '80px' })
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const update = () => setVisible(!document.hidden)
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  return <div ref={scene} className={`terra-scene ${className}`} data-running={inView && visible} role="img" aria-label={label}>{children}</div>
}

function Flow({ points, color = '#67e8d0', delay = 0, dashed = false }: { points: Point[]; color?: string; delay?: number; dashed?: boolean }) {
  const animation = `terra-flow-${useId().replace(/:/g, '')}`
  const distances = points.map((point, index) => {
    const previous = points[index - 1] ?? point
    return Math.hypot(point[0] - previous[0], point[1] - previous[1])
  })
  const total = distances.reduce((sum, distance) => sum + distance, 0) || 1
  let travelled = 0
  const frames = points.map(([horizontal, vertical], index) => {
    travelled += distances[index] ?? 0
    return `${travelled / total * 100}%{transform:translate(${horizontal}px,${vertical}px)}`
  }).join('')

  return (
    <g fill="none">
      <path d={points.map(([horizontal, vertical], index) => `${index ? 'L' : 'M'}${horizontal} ${vertical}`).join(' ')} stroke={color} strokeOpacity=".3" strokeWidth="1.3" strokeLinejoin="round" strokeDasharray={dashed ? '4 6' : undefined} />
      <style>{`@keyframes ${animation}{${frames}}`}</style>
      <circle cx="0" cy="0" r="3" fill={color} className="terra-packet" style={{ animationName: animation, animationDelay: `${delay}s` }} />
      {points.filter((_, index) => index === 0 || index === points.length - 1).map(([horizontal, vertical], index) => <circle key={index} cx={horizontal} cy={vertical} r="3" fill="#0b1725" stroke={color} strokeWidth="1.5" />)}
    </g>
  )
}

function Rack({ horizontal = 0, vertical = 0, scale = 1, color = '#67e8d0' }: { horizontal?: number; vertical?: number; scale?: number; color?: string }) {
  return (
    <g transform={`translate(${horizontal} ${vertical}) scale(${scale})`} strokeLinejoin="round">
      <path d="M0 10 55 -7 94 10 39 28Z" fill="#1c3444" stroke={color} strokeOpacity=".6" />
      <path d="M39 28 94 10V118L39 137Z" fill="#102331" stroke={color} strokeOpacity=".35" />
      <path d="M0 10 39 28V137L0 117Z" fill="#0b1927" stroke={color} strokeOpacity=".45" />
      {[0, 1, 2, 3].map(slot => (
        <g key={slot} transform={`translate(0 ${slot * 25})`}>
          <path d="M45 35 88 20V37L45 52Z" fill="#172c3b" stroke={color} strokeOpacity=".22" />
          <path d="M51 37 72 30M51 42 66 37" stroke={color} strokeOpacity=".45" />
          <circle cx="81" cy="31" r="2" fill={color} className="terra-light" style={{ animationDelay: `${slot * -.7}s` }} />
          <path d="M8 25 29 35M8 29 29 39M8 33 29 43" stroke="#355063" />
        </g>
      ))}
      <path d="M45 128 86 114" stroke={color} strokeWidth="2" strokeOpacity=".65" />
    </g>
  )
}

function Chip({ horizontal = 0, vertical = 0, scale = 1, label = 'GPU', color = '#a5b4fc' }: { horizontal?: number; vertical?: number; scale?: number; label?: string; color?: string }) {
  return (
    <g transform={`translate(${horizontal} ${vertical}) scale(${scale})`} strokeLinejoin="round">
      <path d="M0 0 76 -39 153 0 76 40Z" fill="#142736" stroke={color} strokeOpacity=".6" />
      <path d="M0 0V12L76 53 153 12V0L76 40Z" fill="#0b192b" stroke={color} strokeOpacity=".45" />
      <path d="M39 -2 76 -21 114 -2 76 18Z" fill="#24374b" stroke={color} />
      <path d="M39 -2V7L76 27 114 7V-2L76 18Z" fill="#182c3b" stroke={color} strokeOpacity=".65" />
      {[0, 1, 2, 3].map(pin => <g key={pin} stroke={color} strokeOpacity=".65"><path d={`M${23 + pin * 10} ${-7 - pin * 5}l-10 -6M${95 + pin * 10} ${17 - pin * 5}l10 5M${25 + pin * 10} ${14 + pin * 5}l-8 5`} /></g>)}
      <text x="76" y="1" textAnchor="middle" fill={color} fontSize="13" fontWeight="600" transform="rotate(-1 76 0)">{label}</text>
    </g>
  )
}

function Building({ home = false }: { home?: boolean }) {
  return (
    <g stroke="#67e8d0" strokeOpacity=".6" strokeLinejoin="round">
      <path d="M0 26 66 3 116 28 51 53Z" fill="#172f3d" />
      <path d="M0 26V98L51 126V53Z" fill="#0f202e" />
      <path d="M51 53 116 28V101L51 126Z" fill="#132b38" />
      {home && <path d="M-8 28 32 -17 73 7 124 28 57 55 32 16Z" fill="#24424e" />}
      {[0, 1, 2].map(column => [0, 1].map(row => <path key={`${column}-${row}`} d={`M${61 + column * 17} ${62 + row * 22 - column * 6}l10 -4v13l-10 4Z`} fill="#67e8d0" fillOpacity={row === column ? '.6' : '.15'} />))}
      <path d="M12 49 22 54V68L12 63ZM30 59 40 64V78L30 73ZM12 75 22 80V94L12 89Z" fill="#67e8d0" fillOpacity=".16" />
    </g>
  )
}

export function NetworkIllustration() {
  const grid = `terra-grid-${useId().replace(/:/g, '')}`
  return (
    <figure className="terra-topology">
      <div className="terra-diagram-heading"><span><i /> NETWORK FABRIC</span><span>跨网络资源拓扑 · 示意</span></div>
      <AnimatedScene label="校园机柜、家庭工作站和云端节点通过统一网关连接到 YatTerra，编排 GPU、模型和 Agent 服务。" className="terra-topology-canvas">
        <svg viewBox="0 0 720 600" fill="none" aria-hidden="true">
          <defs><pattern id={grid} width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="skewY(-26)"><path d="M28 0H0V28" stroke="#71adc0" strokeOpacity=".09" strokeWidth=".7" /></pattern></defs>
          <rect width="720" height="600" fill={`url(#${grid})`} />
          <ellipse cx="362" cy="306" rx="274" ry="145" stroke="#4e7b90" strokeOpacity=".24" strokeDasharray="3 8" />
          <ellipse cx="362" cy="306" rx="226" ry="113" stroke="#4e7b90" strokeOpacity=".12" />
          <path d="M34 251V76Q34 53 57 53H230M490 53H663Q686 53 686 76V251M34 381V525Q34 547 57 547H230M490 547H663Q686 547 686 525V381" stroke="#41697d" strokeOpacity=".4" />
          <Flow points={[[172, 203], [225, 232], [225, 260], [304, 300]]} delay={-1.5} />
          <Flow points={[[172, 458], [226, 431], [226, 375], [303, 330]]} delay={-3} />
          <Flow points={[[412, 300], [493, 259], [493, 228], [553, 199]]} color="#a5b4fc" delay={-2.3} />
          <Flow points={[[412, 330], [493, 375], [493, 425], [562, 457]]} color="#f6c889" delay={-.4} />
          <Flow points={[[360, 257], [360, 175], [360, 118]]} color="#8ab4ec" delay={-2} dashed />
          <Flow points={[[360, 363], [360, 442], [360, 496]]} delay={-4} dashed />
          <g transform="translate(62 106)"><Rack /><Rack horizontal={67} vertical={-16} scale={.88} /><text x="58" y="-32" fill="#d2e4e7" fontSize="21">校园实验室</text><text x="59" y="168" fill="#6f97a7" fontSize="15">GPU / STORAGE</text></g>
          <g transform="translate(59 390)"><Building home /><path d="M116 93 157 76V27L116 45Z" fill="#142839" stroke="#67e8d0" strokeOpacity=".6" /><path d="M122 51 150 40V66L122 77Z" fill="#67e8d0" fillOpacity=".12" /><text x="9" y="-32" fill="#d2e4e7" fontSize="21">家庭工作站</text></g>
          <g transform="translate(518 89)"><Chip vertical={73} scale={.9} label="K3s" /><Chip horizontal={18} vertical={37} scale={.66} label="Pod" /><text x="3" y="-15" fill="#d2e4e7" fontSize="21">集群编排</text><text x="11" y="173" fill="#8b9cc9" fontSize="15">NODES / PODS</text></g>
          <g transform="translate(519 396)">
            {[0, 1, 2].map(layer => <g key={layer} transform={`translate(${layer * 7} ${layer * -28})`}><path d="M0 30 69 -3 140 32 69 67Z" fill="#1d2936" stroke="#f6c889" strokeOpacity=".6" /><path d="M0 30V43L69 81 140 46V32L69 67Z" fill="#132130" stroke="#f6c889" strokeOpacity=".35" /><text x="70" y="35" fill="#f6d7ab" fontSize="14" textAnchor="middle">{['MODELS', 'AGENT', 'MCP'][layer]}</text></g>)}
            <text x="2" y="119" fill="#d2e4e7" fontSize="21">AI 工作负载</text>
          </g>
          <g transform="translate(360 309)">
            <ellipse rx="108" ry="55" fill="#67e8d0" fillOpacity=".04" className="terra-core-halo" />
            <path d="M-96 8 0 -41 96 8 0 61Z" fill="#112b3a" stroke="#67e8d0" strokeOpacity=".35" />
            <path d="M-83 -11 0 -55 83 -11V16L0 62 -83 16Z" fill="#10252e" stroke="#67e8d0" strokeOpacity=".65" />
            <path d="M-83 -11 0 -55 83 -11 0 34Z" fill="#1a3b43" stroke="#9ce8d6" />
            <path d="M-61 -12 0 -44 61 -12 0 20Z" stroke="#67e8d0" strokeOpacity=".32" />
            <path d="M-26 -12 0 -27 26 -12 0 3Z" fill="#a4f7dc" fillOpacity=".14" stroke="#a4f7dc" />
            <text y="89" textAnchor="middle" fill="#e0fff4" fontSize="23" fontWeight="600" letterSpacing="2">YatTerra</text>
          </g>
          <g transform="translate(309 79)"><rect width="102" height="44" rx="12" fill="#102331" stroke="#729ac0" strokeOpacity=".5" /><path d="M18 14h18m-18 7h18m-18 7h18" stroke="#8ab4ec" /><text x="67" y="28" fill="#c0d3ee" fontSize="16" textAnchor="middle">网关</text></g>
          <g transform="translate(290 500)"><rect width="140" height="35" rx="17" fill="#0c202d" stroke="#67e8d0" strokeOpacity=".3" /><circle cx="19" cy="18" r="3" fill="#67e8d0" /><text x="80" y="23" fill="#b4d7d5" fontSize="15" textAnchor="middle">权限 · 观测</text></g>
          <text x="284" y="171" fill="#7497ac" fontSize="13" letterSpacing="2">TUNNEL</text>
          <text x="381" y="448" fill="#7497ac" fontSize="13" letterSpacing="2">CONTROL</text>
        </svg>
      </AnimatedScene>
      <figcaption className="terra-topology-caption"><span>ONE FABRIC · MANY PLACES</span><p>设备分布各处，服务连接如一。</p></figcaption>
      <div className="terra-topology-legend"><span><i />本地资源</span><span><i />编排与调度</span><span><i />模型与工具</span></div>
    </figure>
  )
}

export function LayerIllustration({ index }: { index: number }) {
  return (
    <AnimatedScene label={['受限网络通过网关和隧道接入服务', '多台设备与容器组成可调度的资源池', '模型连接 Agent、知识库与 MCP 工具', '权限验证、运行观测和审计形成运维闭环'][index] ?? ''}>
      <svg viewBox="0 0 300 205" fill="none" aria-hidden="true">
        <path d="M15 174H285M15 184H285" stroke="#45627a" strokeOpacity=".17" />
        {index === 0 && <>
          <rect x="14" y="22" width="94" height="148" rx="14" stroke="#67e8d0" strokeOpacity=".3" strokeDasharray="4 5" />
          <text x="61" y="45" fill="#7d9eac" fontSize="11" textAnchor="middle">PRIVATE NETWORK</text>
          <Rack horizontal={26} vertical={64} scale={.55} />
          <Flow points={[[89, 108], [131, 108], [163, 108], [199, 108], [231, 72]]} />
          <Flow points={[[163, 108], [199, 108], [199, 146], [242, 146]]} color="#a5b4fc" delay={-2} />
          <rect x="132" y="84" width="43" height="48" rx="10" fill="#15313b" stroke="#67e8d0" />
          <path d="M143 101h21m-21 8h21m-21 8h13" stroke="#67e8d0" />
          <text x="153" y="155" textAnchor="middle" fill="#a9c8cc" fontSize="11">GATEWAY</text>
          <rect x="220" y="53" width="58" height="38" rx="9" fill="#172b3c" stroke="#8ab4ec" />
          <text x="249" y="77" fill="#c4d9ee" textAnchor="middle" fontSize="12">HTTPS</text>
          <rect x="220" y="129" width="58" height="34" rx="9" fill="#202a42" stroke="#a5b4fc" />
          <text x="249" y="151" fill="#c7d0fa" textAnchor="middle" fontSize="12">SSH</text>
        </>}
        {index === 1 && <>
          <Flow points={[[68, 133], [130, 162], [196, 128]]} color="#8ab4ec" delay={-2} />
          <Flow points={[[130, 162], [218, 177], [269, 151]]} color="#8ab4ec" />
          <Rack horizontal={31} vertical={44} scale={.72} color="#8ab4ec" />
          <Rack horizontal={102} vertical={23} scale={.72} color="#8ab4ec" />
          <Chip horizontal={174} vertical={109} scale={.62} label="Pod" color="#8ab4ec" />
          <Chip horizontal={192} vertical={71} scale={.49} label="Pod" color="#8ab4ec" />
          <path d="M31 29 151 0 283 62" stroke="#8ab4ec" strokeOpacity=".25" strokeDasharray="3 5" />
          <text x="202" y="196" fill="#8baecc" fontSize="11" textAnchor="middle">RESOURCE POOL</text>
        </>}
        {index === 2 && <>
          {[0, 1, 2].map(column => [0, 1, 2].map(row => <g key={`${column}-${row}`}>
            {column < 2 && [0, 1, 2].map(target => <path key={target} d={`M${29 + column * 42} ${51 + row * 39}L${71 + column * 42} ${51 + target * 39}`} stroke="#c4b5fd" strokeOpacity=".22" />)}
            <circle cx={29 + column * 42} cy={51 + row * 39} r="5" fill="#c4b5fd" fillOpacity=".65" className="terra-light" style={{ animationDelay: `${(column + row) * -.6}s` }} />
          </g>))}
          <Flow points={[[113, 90], [151, 90], [185, 63], [253, 63]]} color="#c4b5fd" />
          <Flow points={[[151, 90], [182, 130], [251, 130]]} color="#f6c889" delay={-2} />
          <rect x="175" y="42" width="104" height="42" rx="11" fill="#26213d" stroke="#c4b5fd" strokeOpacity=".7" />
          <text x="226" y="68" fill="#e4d9ff" fontSize="14" textAnchor="middle">AGENT</text>
          <rect x="180" y="110" width="98" height="40" rx="11" fill="#302937" stroke="#f6c889" strokeOpacity=".65" />
          <text x="229" y="135" fill="#f6d9b7" fontSize="13" textAnchor="middle">MCP / RAG</text>
          <text x="71" y="166" textAnchor="middle" fill="#aa9bc4" fontSize="11">MODEL INFERENCE</text>
        </>}
        {index === 3 && <>
          <circle cx="85" cy="94" r="61" stroke="#f6c889" strokeOpacity=".18" />
          <circle cx="85" cy="94" r="48" stroke="#f6c889" strokeOpacity=".35" strokeDasharray="2 6" />
          <path d="M85 55 113 67V94Q113 121 85 137Q57 121 57 94V67Z" fill="#302b2e" stroke="#f6c889" />
          <path d="M72 93 82 103 100 82" stroke="#f6c889" strokeWidth="2" />
          <Flow points={[[144, 94], [165, 94], [165, 53], [193, 53]]} color="#f6c889" />
          <Flow points={[[165, 94], [165, 138], [193, 138]]} color="#67e8d0" delay={-2} />
          <rect x="184" y="30" width="96" height="54" rx="8" fill="#172836" stroke="#607788" strokeOpacity=".4" />
          <path d="M193 65 208 65 218 46 229 71 244 50 254 58H270" stroke="#67e8d0" strokeWidth="1.5" />
          {[0, 1, 2].map(row => <g key={row}><rect x="188" y={107 + row * 19} width="90" height="14" rx="4" fill="#f6c889" fillOpacity=".06" /><circle cx="197" cy={114 + row * 19} r="2" fill="#f6c889" className="terra-light" /><path d={`M207 ${114 + row * 19}h${48 - row * 9}`} stroke="#9b8b80" strokeOpacity=".6" /></g>)}
          <text x="85" y="181" textAnchor="middle" fill="#b6a18d" fontSize="11">ACCESS VERIFIED</text>
        </>}
      </svg>
    </AnimatedScene>
  )
}

export function ScenarioIllustration({ index }: { index: number }) {
  return (
    <AnimatedScene label={['校园建筑连接共享 GPU 机柜与课程开发环境', '家中的工作站和本地 GPU 连接到个人 AI 工作流', '团队开发环境连接模型、API 和应用服务'][index] ?? ''} className="terra-scenario-art">
      <svg viewBox="0 0 360 230" fill="none" aria-hidden="true">
        <path d="M12 170 180 86 346 170 180 254Z" fill="#152a37" fillOpacity=".45" stroke="#517a88" strokeOpacity=".15" />
        <path d="M12 188 180 103 346 188M48 151 214 235M82 134 249 218M118 117 283 200" stroke="#517a88" strokeOpacity=".13" />
        {index === 0 && <>
          <g transform="translate(33 56)"><Building /><path d="M44 25V-15l26 10 -26 10" stroke="#67e8d0" strokeOpacity=".7" /></g>
          <Rack horizontal={204} vertical={49} scale={.85} />
          <Rack horizontal={263} vertical={32} scale={.56} />
          <Flow points={[[120, 182], [173, 208], [252, 170]]} delay={-1} />
          <text x="181" y="25" fill="#789d9c" fontSize="11" letterSpacing="2">CAMPUS / SHARED COMPUTE</text>
        </>}
        {index === 1 && <>
          <g transform="translate(28 74)"><Building home /></g>
          <Chip horizontal={172} vertical={164} scale={.98} />
          <g transform="translate(206 24)"><path d="M0 17 78 0V73L0 91Z" fill="#172e3b" stroke="#a5b4fc" strokeOpacity=".7" /><path d="M9 26 68 13V63L9 78Z" fill="#0a1d2b" stroke="#a5b4fc" strokeOpacity=".3" /><path d="M19 45 28 50 19 58M34 57 52 52M36 82V100L19 110 62 100 47 95V80" stroke="#a5b4fc" /><path d="M16 34 49 26M16 38 39 32" stroke="#a5b4fc" strokeOpacity=".3" /></g>
          <Flow points={[[127, 186], [164, 204], [210, 181]]} color="#a5b4fc" delay={-1.5} />
          <text x="170" y="18" fill="#9d9cbd" fontSize="11" letterSpacing="2">HOME / PERSONAL AI</text>
        </>}
        {index === 2 && <>
          <Rack horizontal={25} vertical={53} scale={.75} color="#f6c889" />
          <Flow points={[[89, 154], [150, 187], [210, 151]]} color="#f6c889" />
          <Flow points={[[150, 187], [231, 223], [307, 181], [307, 99]]} color="#c4b5fd" delay={-2} />
          {[0, 1, 2].map(layer => <g key={layer} transform={`translate(${152 + layer * 27} ${124 - layer * 38})`}><path d="M0 0 71 -34 140 2 69 38Z" fill="#28313f" stroke="#f6c889" strokeOpacity=".7" /><path d="M0 0V16L69 53 140 18V2L69 38Z" fill="#162635" stroke="#f6c889" strokeOpacity=".35" /><text x="70" y="8" fill="#f6d9b7" fontSize="13" textAnchor="middle">{['API', 'MODEL', 'APP'][layer]}</text></g>)}
          <text x="91" y="24" fill="#b6a18d" fontSize="11" letterSpacing="2">TEAM / BUILD TOGETHER</text>
        </>}
      </svg>
    </AnimatedScene>
  )
}

export function WorkflowIllustration() {
  return (
    <AnimatedScene label="从代码提交到容器部署、模型调用和服务访问的应用交付流程" className="terra-workflow-art">
      <svg viewBox="0 0 620 280" fill="none" aria-hidden="true">
        <path d="M20 218 280 83 606 209M77 249 328 111M162 274 413 140" stroke="#436376" strokeOpacity=".23" />
        <Flow points={[[134, 153], [214, 199], [307, 153]]} delay={-2} />
        <Flow points={[[309, 154], [410, 208], [521, 147]]} color="#c4b5fd" delay={-.5} />
        <g transform="translate(38 45)"><path d="M0 32 108 0V95L0 132Z" fill="#132a39" stroke="#67e8d0" strokeOpacity=".7" /><path d="M9 41 99 14V84L9 115Z" fill="#091b28" stroke="#67e8d0" strokeOpacity=".2" /><path d="M20 67 35 74 20 91M46 88 69 80M19 51 64 38M19 55 47 47" stroke="#67e8d0" strokeOpacity=".8" /><path d="M0 132 25 144 135 104 108 95" stroke="#67e8d0" strokeOpacity=".4" fill="#1a3543" /></g>
        <Rack horizontal={258} vertical={40} scale={.92} color="#8ab4ec" />
        <Chip horizontal={455} vertical={117} scale={.83} label="AI" color="#c4b5fd" />
        <g transform="translate(485 20)"><rect width="90" height="37" rx="10" fill="#231f39" stroke="#c4b5fd" strokeOpacity=".6" /><path d="M11 13h24m-24 6h39m-39 6h31" stroke="#c4b5fd" strokeOpacity=".6" /><circle cx="74" cy="18" r="4" fill="#c4b5fd" className="terra-light" /></g>
        <text x="94" y="226" textAnchor="middle" fill="#accfca" fontSize="15">代码与想法</text>
        <text x="300" y="225" textAnchor="middle" fill="#aec5df" fontSize="15">容器与部署</text>
        <text x="519" y="225" textAnchor="middle" fill="#d0c0ea" fontSize="15">模型与服务</text>
        <text x="300" y="260" textAnchor="middle" fill="#607f91" fontSize="11" letterSpacing="3">BUILD → DEPLOY → SERVE</text>
      </svg>
    </AnimatedScene>
  )
}
