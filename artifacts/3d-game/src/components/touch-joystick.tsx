import { useRef, useState, type PointerEvent } from 'react';

type TouchJoystickProps = {
  side: 'left' | 'right';
  label: string;
  onChange: (x: number, y: number) => void;
};

const RADIUS = 56;

export function TouchJoystick({ side, label, onChange }: TouchJoystickProps) {
  const baseRef = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  const update = (event: PointerEvent<HTMLDivElement>) => {
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    const scale = distance > RADIUS ? RADIUS / distance : 1;
    const x = dx * scale;
    const y = dy * scale;
    setKnob({ x, y });
    onChange(x / RADIUS, y / RADIUS);
  };

  const start = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    update(event);
  };

  const release = () => {
    setKnob({ x: 0, y: 0 });
    onChange(0, 0);
  };

  return (
    <div
      ref={baseRef}
      className="touch-joystick"
      aria-label={label}
      data-testid={`joystick-${side}`}
      onPointerDown={start}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event); }}
      onPointerUp={release}
      onPointerCancel={release}
      style={{
        position: 'absolute',
        bottom: 24,
        left: side === 'left' ? 24 : undefined,
        right: side === 'right' ? 24 : undefined,
        width: RADIUS * 2 + 16,
        height: RADIUS * 2 + 16,
        borderRadius: '50%',
        background: 'rgba(13,24,27,.42)',
        border: '2px solid rgba(241,238,226,.32)',
        touchAction: 'none',
        pointerEvents: 'auto',
        userSelect: 'none',
        zIndex: 6,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'rgba(241,238,226,.85)',
          boxShadow: '0 4px 14px rgba(0,0,0,.35)',
          transform: `translate(${knob.x}px, ${knob.y}px)`,
          transition: knob.x === 0 && knob.y === 0 ? 'transform 120ms ease-out' : 'none',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
