// The inspector's inputs: numbers that commit on Enter or blur, vectors, choices.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Vec3 } from '../model/types';

interface NumberProps {
  value: number;
  onChange: (value: number) => void;
  decimals?: number;
  min?: number;
  max?: number;
  step?: number;
  /** Shown as typed, so degrees can be edited while radians are stored. */
  display?: { toView: (v: number) => number; fromView: (v: number) => number };
  'aria-label'?: string;
}

const show = (v: number, decimals: number): string => String(Number(v.toFixed(decimals)));

/** A number box: typing is committed on Enter or when the box loses focus; the arrow keys step it. */
export function NumberInput({ value, onChange, decimals = 3, min, max, step, display, ...rest }: NumberProps) {
  const view = display ? display.toView(value) : value;
  const [text, setText] = useState(show(view, decimals));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(show(view, decimals));
  }, [view, decimals, editing]);
  const commit = (raw: string) => {
    const typed = Number(raw.trim().replace(',', '.'));
    if (raw.trim() !== '' && Number.isFinite(typed)) {
      let v = display ? display.fromView(typed) : typed;
      if (min !== undefined) v = Math.max(v, min);
      if (max !== undefined) v = Math.min(v, max);
      if (v !== value) onChange(v);
      else setText(show(view, decimals));
    } else setText(show(view, decimals));
  };
  return (
    <input
      className="number-input"
      type="text"
      inputMode="decimal"
      value={text}
      aria-label={rest['aria-label']}
      onFocus={(e) => {
        setEditing(true);
        e.currentTarget.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        setEditing(false);
        commit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit(e.currentTarget.value);
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setText(show(view, decimals));
          e.currentTarget.blur();
        } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && step) {
          e.preventDefault();
          const k = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1);
          const next = (display ? display.toView(value) : value) + k * step;
          commit(String(next));
        }
      }}
    />
  );
}

export function Field({ label, unit, children, inline }: { label: string; unit?: string; children: ReactNode; inline?: boolean }) {
  return (
    <div className={inline ? 'field inline' : 'field'}>
      <span className="label">
        {label}
        {unit && !inline && <span className="unit">{unit}</span>}
      </span>
      {children}
    </div>
  );
}

export function NumberField({ label, unit, ...props }: NumberProps & { label: string; unit?: string }) {
  return (
    <Field label={label} unit={unit}>
      <NumberInput aria-label={label} {...props} />
    </Field>
  );
}

const AXES = ['x', 'y', 'z'] as const;

export function Vec3Field({ label, unit, value, onChange, decimals = 3, step, display, min }: { label: string; unit?: string; value: Vec3; onChange: (v: Vec3) => void; decimals?: number; step?: number; display?: NumberProps['display']; min?: number }) {
  return (
    <Field label={label} unit={unit}>
      <div className="vec3">
        {AXES.map((axis, i) => (
          <span key={axis}>
            <b>{axis}</b>
            <NumberInput
              aria-label={`${label} ${axis}`}
              value={value[i]}
              decimals={decimals}
              step={step}
              min={min}
              display={display}
              onChange={(v) => {
                const next = [...value] as Vec3;
                next[i] = v;
                onChange(next);
              }}
            />
          </span>
        ))}
      </div>
    </Field>
  );
}

export function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const t = text.trim();
    if (t && t !== value) onChange(t);
    else setText(value);
  };
  return (
    <Field label={label}>
      <input
        className="text-input"
        type="text"
        value={text}
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setText(value);
            e.currentTarget.blur();
          }
        }}
      />
    </Field>
  );
}

export function SelectField<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <Field label={label}>
      <select className="select" value={value} aria-label={label} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function CheckField({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="field">
      <label className="check">
        <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    </div>
  );
}

const toHex = (rgb: Vec3): string => '#' + rgb.map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string): Vec3 => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Vec3;

export function ColorField({ label, value, onChange }: { label: string; value: Vec3; onChange: (v: Vec3) => void }) {
  return (
    <Field label={label} inline>
      <input className="color-swatch" type="color" value={toHex(value)} aria-label={label} onChange={(e) => onChange(fromHex(e.target.value))} />
    </Field>
  );
}

/** Degrees in the boxes, radians in the world. */
export const DEGREES = { toView: (r: number) => (r * 180) / Math.PI, fromView: (d: number) => (d * Math.PI) / 180 };
