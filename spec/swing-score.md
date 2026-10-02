# Swing score

A swing scores 0 to 1. The score multiplies the impulse in the damage formula.

## Inputs

| Input | From |
|---|---|
| radial speed at impact | target phone, Doppler on the whoosh's tonal core |
| speed, plane, twist, timing, follow-through | striker phone, IMU (DeviceMotion + DeviceOrientation) |

Striker speed and Doppler speed must agree within 25%, or the turn is void.

## Factors

Each factor is a tent: 10000 basis points at the ideal, falling linearly to 0 at the
zero point. Tents, not bell curves, so the Zig handler needs no `exp`.

| Factor | Ideal | Zero at |
|---|---|---|
| speed at impact (the lower of IMU and Doppler) | 300 cm/s | 150 or 500 cm/s |
| plane (gravity vs swing plane) | 0° | 25° |
| twist (peak gyro roll during swing) | 0°/s | 90°/s |
| timing (impact vs target rest) | 0 ms | ± 150 ms |
| follow-through | decelerated after impact | braking before impact scores 3000 bp, not 0 |

`score = speed × plane × twist × timing × followThrough`, each multiplication floored to basis points.
The two speeds must agree within 25% of the larger, or the turn is void.

## Damage

```
e      = (e_striker + e_target) / 2                 percent
mu     = m1·m2 / (m1 + m2)                           cg
J      = (100 + e) · mu · v / 100                    cg·cm/s
J_eff  = J · score / 10000
damage_k        = J_eff² / ((hardness_k + 25) · 475000)   hp (0..10000); +25 keeps 1..100 to a ~5x spread
damage_target  ·= 125 / 100                          the anchored nut takes more
tension_k       = J_eff / 150 · (100 - stringElasticity_k) / 100   mN
snap_k          = tension_k > strength_k · 100       strength is in deci-newtons
```

Why impulse, not centripetal load: `m·v²/L` for a 12 g nut at 3 m/s is about half a
newton, which no string notices. What snaps a string is the jerk at impact, the impulse
delivered over about 15 ms. With these constants an average 0.6 swing costs the target
about 10% hp and the striker about 8%, a weak string (10 dN) snaps on a perfect hit and
an average one (35 dN) does not, and a match of average swings runs 10 to 20 turns.

All arithmetic is integer, BigInt where a square can pass 2^53. `mirror/src/physics.ts`
is the reference and `spec/vectors.json` holds 12 impact vectors for the Zig port.

Everything above is a starting guess. Phase 2 step 1 replaces the numbers with
measured ones.
