# Swing score

A swing scores 0 to 1. The score multiplies the impulse in the damage formula.

## Inputs

| Input | From |
|---|---|
| radial speed at impact | target phone, Doppler on the whoosh's tonal core |
| speed, plane, twist, timing, follow-through | striker phone, IMU (DeviceMotion + DeviceOrientation) |

Striker speed and Doppler speed must agree within 25%, or the turn is void.

## Factors

Each factor is a bell curve `exp(-((x - ideal) / width)^2)` clamped to 0 past its zero point.

| Factor | Ideal | Width | Zero at |
|---|---|---|---|
| speed at impact | 3.0 m/s | 0.8 m/s | < 1.5 or > 5.0 m/s |
| plane (gravity vs swing plane) | 0° | 10° | > 25° |
| twist (gyro roll during swing) | 0°/s | 35°/s | > 90°/s |
| timing (impact vs target rest) | 0 ms | 60 ms | ± 150 ms |
| follow-through (decel after impact) | no braking before impact | — | braking before impact |

`score = speed × plane × twist × timing × followThrough`.

## Damage

```
e  = (e_striker + e_target) / 2
J  = (1 + e) · m1·m2 / (m1 + m2) · v · score
damage_k = round(J² / (hardness_k · c))
```

`c` is tuned so an average 0.6 swing costs about 8% hp. String snaps when
`m·v²/L + m·g > strength`. All arithmetic is integer in the handler; the
mirror's `previewMatch` is the reference implementation.

Everything above is a starting guess. Phase 2 step 1 replaces the numbers with
measured ones.
