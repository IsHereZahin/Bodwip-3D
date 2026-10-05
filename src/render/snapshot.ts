/**
 * The look of the world a shot is drawn in (the shared uniforms, the lights, the sky, the water's colour and
 * the like), kept as plain values so a second world can be laid over it and taken off again. The film draws the
 * shot it is leaving, still moving, in its own light, season and weather beneath the one dissolving in.
 */

/** A value that can be copied in place (three's vectors, colours, matrices, quaternions). */
interface Copyable {
  copy(v: unknown): unknown;
  clone(): unknown;
}

type Holder = Record<string, unknown>;

const copyable = (v: unknown): v is Copyable =>
  typeof v === 'object' && v !== null && !(v as { isTexture?: boolean }).isTexture && typeof (v as Copyable).copy === 'function' && typeof (v as Copyable).clone === 'function';

/** The values held in one capture, in the order of the fields tracked. */
export type Captured = unknown[];

export class WorldLook {
  private readonly fields: { holder: Holder; key: string }[] = [];

  /** Tracks `holder[key]`: a number, a boolean, or a vector, colour or matrix copied in place. */
  track(holder: object, key: string): this {
    const v = (holder as Holder)[key];
    if (typeof v === 'number' || typeof v === 'boolean' || copyable(v)) this.fields.push({ holder: holder as Holder, key });
    return this;
  }

  /** Tracks the `value` of every uniform in `uniforms` that holds a number, vector or colour, but those named in `skip`. */
  trackUniforms(uniforms: Record<string, { value: unknown }>, skip: readonly string[]): this {
    for (const [name, u] of Object.entries(uniforms)) if (!skip.includes(name)) this.track(u, 'value');
    return this;
  }

  /** Copies the tracked values into `into` (reusing its objects). */
  capture(into: Captured): Captured {
    this.fields.forEach(({ holder, key }, i) => {
      const v = holder[key];
      if (copyable(v)) {
        const kept = into[i] as Copyable | undefined;
        if (kept) kept.copy(v);
        else into[i] = v.clone();
      } else into[i] = v;
    });
    return into;
  }

  /** Puts captured values back. */
  apply(from: Captured): void {
    this.fields.forEach(({ holder, key }, i) => {
      const v = holder[key];
      if (copyable(v)) v.copy(from[i]);
      else holder[key] = from[i];
    });
  }
}
