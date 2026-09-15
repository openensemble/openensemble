// Numerical primitives owned by this project. Quaternions are [x, y, z, w].
export const TAU = 2 * Math.PI;
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const add = (a, b) => a.length===3?[a[0]+b[0],a[1]+b[1],a[2]+b[2]]:a.length===4?[a[0]+b[0],a[1]+b[1],a[2]+b[2],a[3]+b[3]]:a.map((x, i) => x + b[i]);
export const sub = (a, b) => a.length===3?[a[0]-b[0],a[1]-b[1],a[2]-b[2]]:a.length===4?[a[0]-b[0],a[1]-b[1],a[2]-b[2],a[3]-b[3]]:a.map((x, i) => x - b[i]);
export const mul = (v, s) => v.length===3?[v[0]*s,v[1]*s,v[2]*s]:v.length===4?[v[0]*s,v[1]*s,v[2]*s,v[3]*s]:v.map(x => x * s);
export const dot = (a, b) => a.length===3?0+a[0]*b[0]+a[1]*b[1]+a[2]*b[2]:a.length===4?0+a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3]:a.reduce((s, x, i) => s + x * b[i], 0);
export const length = v => v.length===3?Math.hypot(v[0],v[1],v[2]):v.length===4?Math.hypot(v[0],v[1],v[2],v[3]):Math.hypot(...v);
export const distance = (a, b) => length(sub(a, b));
export const mix = (a, b, t) => a.map((x, i) => lerp(x, b[i], t));
export const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export function unit(v,fallback=[0,1,0]){const magnitude=length(v);return magnitude>1e-10?mul(v,1/magnitude):[...fallback];}
export const identity = () => [0, 0, 0, 1];
export const inverse = q => [-q[0], -q[1], -q[2], q[3]];
export function qmul(a, b) {
  const x=a[0],y=a[1],z=a[2],w=a[3],X=b[0],Y=b[1],Z=b[2],W=b[3];
  return [w*X+x*W+y*Z-z*Y, w*Y-x*Z+y*W+z*X, w*Z+x*Y-y*X+z*W, w*W-x*X-y*Y-z*Z];
}
export function rotate(q, v) {
  const x=(q[1]*v[2]-q[2]*v[1])*2,y=(q[2]*v[0]-q[0]*v[2])*2,z=(q[0]*v[1]-q[1]*v[0])*2;
  return [v[0]+(x*q[3]+(q[1]*z-q[2]*y)),v[1]+(y*q[3]+(q[2]*x-q[0]*z)),v[2]+(z*q[3]+(q[0]*y-q[1]*x))];
}
export function axisAngle(axis, angle) {
  return [...mul(unit(axis), Math.sin(angle / 2)), Math.cos(angle / 2)];
}
export const yaw = angle => axisAngle([0, 1, 0], angle);
export const angles = ([x,y,z]) => qmul(qmul(axisAngle([0,1,0],y), axisAngle([1,0,0],x)), axisAngle([0,0,1],z));
export function fromTo(a, b) {
  a = unit(a); b = unit(b);
  const d = clamp(dot(a,b), -1, 1);
  if (d < -0.999999) return axisAngle(unit(cross(a, Math.abs(a[0]) < .8 ? [1,0,0] : [0,1,0])), Math.PI);
  return unit([...cross(a,b), 1+d], identity());
}
export function qlog(q) {
  if (q[3] < 0) q = mul(q, -1);
  const s = length(q.slice(0,3));
  return s < 1e-10 ? mul(q.slice(0,3), 2) : mul(q.slice(0,3), 2 * Math.atan2(s, q[3]) / s);
}
export function qexp(v) {
  const a = length(v);
  return a < 1e-10 ? unit([...mul(v, .5), 1]) : axisAngle(mul(v, 1/a), a);
}
export const qdistance = (a,b) => length(qlog(qmul(a,inverse(b))));
export const slerp = (a,b,t) => qmul(qexp(mul(qlog(qmul(b,inverse(a))),t)),a);
// A rest-to-rest minimum-jerk segment: position, velocity and acceleration
// meet at both boundaries. Impacts and flight must use their own timing.
export function ease(x) { x = clamp(x); return x*x*x*(10+x*(-15+6*x)); }
export const ramp = (t, a, b) => ease((t-a)/(b-a));
export const envelope = (t,a,b,c,d) => ramp(t,a,b) * (1-ramp(t,c,d));
// Integrate a smooth velocity ramp, cruise, and deceleration. A whole-clip
// quintic position curve makes middle footsteps disproportionately long.
export function travelProgress(t,acceleration=.2) {
  t=clamp(t);const a=acceleration, speed=1/(1-a);
  const integral=u=>2.5*u**4-3*u**5+u**6;
  if(t<a)return speed*a*integral(t/a);
  if(t>1-a)return 1-speed*a*integral((1-t)/a);
  return speed*(t-a*.5);
}
export function decay(offset, velocity, seconds, response = .18) {
  const omega = 4 / response, t = Math.max(0,seconds);
  return (offset + (velocity + omega*offset)*t) * Math.exp(-omega*t);
}
export function frameRotation(fromDirection, fromNormal, toDirection, toNormal) {
  const swing = fromTo(fromDirection, toDirection);
  const axis = unit(toDirection);
  const a0 = rotate(swing, fromNormal);
  const a = unit(sub(a0,mul(axis,dot(a0,axis))));
  const b = unit(sub(toNormal,mul(axis,dot(toNormal,axis))));
  const roll = Math.atan2(dot(axis,cross(a,b)),clamp(dot(a,b),-1,1));
  return qmul(axisAngle(axis,roll),swing);
}
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state,1664525)+1013904223) >>> 0;
    return state / 4294967296;
  };
}
export function finiteVector(v, size = 3) {
  return Array.isArray(v) && v.length === size && v.every(Number.isFinite);
}
