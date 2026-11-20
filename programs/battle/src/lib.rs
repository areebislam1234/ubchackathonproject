//! StakeClash battle engine 2, ported line for line from `shared/battle2.js`.
//!
//! Integer arithmetic only, fixed-size arrays, no allocation: it runs inside the Solana program
//! and must give exactly the same result as the JavaScript engine for the same inputs and seed.
//! `tests/vectors.rs` checks that against battles recorded from the JavaScript engine.
#![cfg_attr(not(test), no_std)]

extern crate alloc;
use alloc::boxed::Box;

pub const B: i64 = 10_000;
pub const ROUNDS: u32 = 16;
pub const MAX_SLOTS: usize = 11; // 9 formation slots, watchtowers (9), a boss (10)

// Unit indices follow UNIT_KEYS in shared/rules.js.
pub const INFANTRY: u8 = 0;
pub const ARCHER: u8 = 1;
pub const TANK: u8 = 2;
pub const CAVALRY: u8 = 3;
pub const SIEGE: u8 = 4;
pub const SUPPORT: u8 = 5;
pub const TOWER: u8 = 6;
pub const BOSS: u8 = 7;
pub const UNIT_COUNT: usize = 6;

// Orders follow ORDER_KEYS.
pub const AGGRESSIVE: u8 = 0;
pub const DEFENSIVE: u8 = 1;
pub const FOCUS: u8 = 2;
pub const HOLD: u8 = 3;
pub const FLANK: u8 = 4;

// Abilities follow ABILITY_KEYS (bit i of a loadout mask).
pub const BULWARK: u8 = 0;
pub const TAUNT: u8 = 1;
pub const AMBUSH: u8 = 2;
pub const FIRSTSTRIKE: u8 = 3;
pub const VOLLEY: u8 = 4;
pub const PINNING: u8 = 5;
pub const BOMBARDMENT: u8 = 6;
pub const SIEGEBREAKER: u8 = 7;
pub const REVIVE: u8 = 8;
pub const RALLY: u8 = 9;
pub const ABILITY_COUNT: u8 = 10;
pub const MAX_LOADOUT: u32 = 2;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
    Guardian,
    Raider,
    Ranger,
    Artillery,
    Support,
    Tower,
    Boss,
}

const fn class_of(unit: u8) -> Class {
    match unit {
        INFANTRY | TANK => Class::Guardian,
        CAVALRY => Class::Raider,
        ARCHER => Class::Ranger,
        SIEGE => Class::Artillery,
        SUPPORT => Class::Support,
        TOWER => Class::Tower,
        _ => Class::Boss,
    }
}

/// COMBAT_STATS: (hp, atk, intercept, splash, heal)
const fn stats_of(unit: u8) -> (i64, i64, i64, i64, i64) {
    match unit {
        INFANTRY => (100, 18, 1500, 0, 0),
        TANK => (420, 36, 3500, 0, 0),
        CAVALRY => (140, 36, 0, 0, 0),
        ARCHER => (60, 26, 0, 0, 0),
        SIEGE => (220, 80, 0, 5000, 0),
        SUPPORT => (120, 8, 0, 0, 25),
        _ => (260, 60, 0, 0, 0), // tower
    }
}

/// CLASS_COUNTERS[attacker][target], basis points.
fn counter_of(a: Class, t: Class) -> i64 {
    match (a, t) {
        (Class::Guardian, Class::Raider) => 20000,
        (Class::Raider, Class::Ranger) => 15000,
        (Class::Raider, Class::Artillery) => 18000,
        (Class::Raider, Class::Support) => 15000,
        (Class::Raider, Class::Guardian) => 7000,
        (Class::Ranger, Class::Guardian) => 13500,
        (Class::Tower, Class::Raider) => 12000,
        _ => B,
    }
}

const ROLL_MIN: i64 = 7000;
const ROLL_MAX: i64 = 13000;
const EXPOSED_BPS: i64 = 2500;
const RANGER_EXPOSED_BPS: i64 = 2000;
const CLUSTER_BPS_PER_10: i64 = 1200;
const CLUSTER_MAX_BPS: i64 = 6000;
const AURA_BPS: i64 = 1000;
const BOSS_COUNTER_BPS: i64 = 15000;
const HOLD_INTERCEPT_BPS: i64 = 1500;

fn order_dmg(o: u8) -> i64 {
    match o {
        AGGRESSIVE => 1500,
        DEFENSIVE => -1000,
        _ => 0,
    }
}
fn order_taken(o: u8) -> i64 {
    match o {
        AGGRESSIVE => 2000,
        DEFENSIVE => -2000,
        _ => 0,
    }
}

const fn rank_of(c: Class) -> i32 {
    match c {
        Class::Raider => 0,
        Class::Ranger => 1,
        Class::Artillery | Class::Boss => 2,
        Class::Guardian | Class::Tower => 3,
        Class::Support => 4,
    }
}
const fn value_of(c: Class) -> i32 {
    match c {
        Class::Artillery => 3,
        Class::Ranger | Class::Support => 2,
        _ => 1,
    }
}

#[inline]
fn mul(v: i64, bps: i64) -> i64 {
    // Math.floor((v * bps) / B); every caller passes v >= 0 and bps > 0
    (v * bps).div_euclid(B)
}

/// xorshift32, identical to the JavaScript generator.
pub struct Rng(u32);
impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(if seed == 0 { 0x9e37_79b9 } else { seed })
    }
    pub fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
}

/// A boss champion: one huge unit standing mid-centre behind its escort.
#[derive(Clone, Copy, Default, Debug)]
pub struct Champion {
    pub hp: u32,
    /// damage per round: floor(dmg * 60 / max(1, cooldown)), computed off-chain from the boss table
    pub atk: u32,
    pub splash: bool,
}

/// One side of a battle, as the program stores it.
#[derive(Clone, Copy, Default, Debug)]
pub struct SideInput {
    /// (unit, count) per slot, front row first; count 0 = empty.
    pub slots: [(u8, u16); 9],
    pub order: u8,
    /// Ability loadout in the order chosen (u8::MAX = none). Only the first two distinct are used.
    pub abilities: [u8; 2],
    /// Unit levels 1..=5 by unit index (0 is read as 1).
    pub levels: [u8; UNIT_COUNT],
    /// Damage bonus per unit, basis points; index UNIT_COUNT applies to all units.
    pub boosts: [i32; UNIT_COUNT + 1],
    /// HP bonus per unit, basis points; index UNIT_COUNT applies to all units.
    pub vigor: [i32; UNIT_COUNT + 1],
    pub towers: u8,
    pub champion: Option<Champion>,
}

#[derive(Clone, Copy, Default)]
struct Slot {
    used: bool,
    idx: u8,
    row: u8,
    lane: u8,
    unit: u8,
    n0: i64,
    unit_hp: i64,
    hp_max: i64,
    hp: i64,
    atk: i64,
    heal: i64,
    intercept: i64,
    splash: i64,
    pinning: bool,
    breaker: bool,
    pinned: bool,
}
impl Slot {
    fn cls(&self) -> Class {
        class_of(self.unit)
    }
    fn alive(&self) -> bool {
        self.used && self.hp > 0
    }
    fn count(&self) -> i64 {
        if self.hp <= 0 {
            0
        } else {
            (self.hp + self.unit_hp - 1) / self.unit_hp
        }
    }
}

struct Side {
    order: u8,
    mask: u16,
    revived: bool,
    slots: [Slot; MAX_SLOTS],
    len: usize,
}
impl Side {
    fn has(&self, ab: u8) -> bool {
        self.mask & (1 << ab) != 0
    }
    fn any_alive(&self) -> bool {
        self.slots[..self.len].iter().any(|s| s.alive())
    }
}

/// cleanLoadout: the first MAX_LOADOUT distinct, valid abilities, as a bit mask.
pub fn loadout_mask(list: &[u8; 2]) -> u16 {
    let mut m = 0u16;
    let mut n = 0;
    for &a in list.iter() {
        if a < ABILITY_COUNT && m & (1 << a) == 0 && n < MAX_LOADOUT {
            m |= 1 << a;
            n += 1;
        }
    }
    m
}

fn level_bps(l: u8) -> i64 {
    B + 1200 * (core::cmp::max(1, l as i64) - 1)
}

fn make_side(spec: &SideInput) -> Side {
    let mask = loadout_mask(&spec.abilities);
    let order = if spec.order <= FLANK { spec.order } else { HOLD };
    let mut side = Side { order, mask, revived: false, slots: [Slot::default(); MAX_SLOTS], len: 0 };
    for (i, &(unit, n)) in spec.slots.iter().enumerate() {
        if n == 0 || unit as usize >= UNIT_COUNT {
            continue;
        }
        let (hp, atk, icp, splash, heal) = stats_of(unit);
        let u = unit as usize;
        let lv = level_bps(spec.levels[u]);
        let hp_bps = mul(lv, B + spec.vigor[u] as i64 + spec.vigor[UNIT_COUNT] as i64);
        let dmg_bps = mul(lv, B + spec.boosts[u] as i64 + spec.boosts[UNIT_COUNT] as i64);
        let unit_hp = core::cmp::max(1, mul(hp, hp_bps));
        let n = n as i64;
        let bulwark = if icp > 0 && side.has(BULWARK) { if unit == TANK { 1500 } else { 1000 } } else { 0 };
        side.slots[side.len] = Slot {
            used: true,
            idx: i as u8,
            row: (i / 3) as u8,
            lane: (i % 3) as u8,
            unit,
            n0: n,
            unit_hp,
            hp_max: unit_hp * n,
            hp: unit_hp * n,
            atk: mul(atk, dmg_bps),
            heal: if heal > 0 { mul(heal, lv) } else { 0 },
            intercept: icp + bulwark,
            splash,
            pinning: class_of(unit) == Class::Ranger && side.has(PINNING),
            breaker: class_of(unit) == Class::Artillery && side.has(SIEGEBREAKER),
            pinned: false,
        };
        side.len += 1;
    }
    if spec.towers > 0 {
        let (hp, atk, ..) = stats_of(TOWER);
        let t = spec.towers as i64;
        side.slots[side.len] = Slot { used: true, idx: 9, row: 2, lane: 1, unit: TOWER, n0: t, unit_hp: hp, hp_max: hp * t, hp: hp * t, atk, ..Default::default() };
        side.len += 1;
    }
    if let Some(c) = spec.champion {
        let atk = c.atk as i64;
        let hp = c.hp as i64;
        side.slots[side.len] = Slot { used: true, idx: 10, row: 1, lane: 1, unit: BOSS, n0: 1, unit_hp: hp, hp_max: hp, hp, atk, splash: if c.splash { 5000 } else { 0 }, ..Default::default() };
        side.len += 1;
    }
    side
}

fn lane_dist(a: &Slot, b: &Slot) -> i64 {
    (a.lane as i64 - b.lane as i64).abs()
}

fn exposed(side: &Side, s: &Slot) -> bool {
    if s.row == 0 {
        return false;
    }
    !side.slots[..side.len].iter().any(|o| o.alive() && o.row == 0 && o.lane == s.lane)
}

/// pick(): the first slot for which no later slot is "better" (same scan as the JS reducer).
fn pick<F: Fn(&Slot, &Slot) -> bool, P: Fn(usize, &Slot) -> bool>(side: &Side, keep: P, better: F) -> Option<usize> {
    let mut best: Option<usize> = None;
    for i in 0..side.len {
        let s = &side.slots[i];
        if !keep(i, s) {
            continue;
        }
        match best {
            None => best = Some(i),
            Some(b) => {
                if better(s, &side.slots[b]) {
                    best = Some(i)
                }
            }
        }
    }
    best
}

/// Who a slot attacks, by its class and its side's order (chooseTarget).
fn choose_target(a: &Slot, order: u8, enemy: &Side, round: u32, skip: Option<usize>) -> Option<usize> {
    let ok = |i: usize, s: &Slot| s.alive() && Some(i) != skip;
    if !enemy.slots[..enemy.len].iter().enumerate().any(|(i, s)| ok(i, s)) {
        return None;
    }
    let near = |x: &Slot, y: &Slot| -> i64 {
        let d = lane_dist(x, a) - lane_dist(y, a);
        if d != 0 { d } else { x.idx as i64 - y.idx as i64 }
    };
    let ac = a.cls();
    if order == FOCUS {
        return pick(enemy, ok, |x, y| x.hp < y.hp || (x.hp == y.hp && x.idx < y.idx));
    }
    if ac == Class::Ranger && a.pinning {
        if let Some(i) = pick(enemy, |i, s| ok(i, s) && s.cls() == Class::Raider, |x, y| near(x, y) < 0) {
            return Some(i);
        }
    }
    if ac == Class::Raider && round <= 1 && enemy.has(TAUNT) {
        if let Some(i) = pick(enemy, |i, s| ok(i, s) && s.cls() == Class::Guardian, |x, y| near(x, y) < 0) {
            return Some(i);
        }
    }
    let by_value = |x: &Slot, y: &Slot| value_of(x.cls()) > value_of(y.cls()) || (value_of(x.cls()) == value_of(y.cls()) && near(x, y) < 0);
    if ac == Class::Raider {
        if let Some(i) = pick(enemy, |i, s| ok(i, s) && s.row > 0 && exposed(enemy, s), by_value) {
            return Some(i);
        }
        if let Some(i) = pick(enemy, |i, s| ok(i, s) && s.row > 0, by_value) {
            return Some(i);
        }
        return pick(enemy, ok, |x, y| near(x, y) < 0);
    }
    if ac == Class::Ranger {
        if let Some(i) = pick(enemy, |i, s| ok(i, s) && s.row > 0 && exposed(enemy, s), by_value) {
            return Some(i);
        }
        if let Some(i) = pick(enemy, |i, s| ok(i, s) && s.cls() == Class::Guardian, |x, y| x.hp < y.hp || (x.hp == y.hp && x.idx < y.idx)) {
            return Some(i);
        }
        // JS: `x.row - y.row || near(x, y) < 0` — any difference in rows is truthy
        return pick(enemy, ok, |x, y| x.row != y.row || near(x, y) < 0);
    }
    if a.breaker {
        if let Some(i) = pick(enemy, |i, s| ok(i, s) && (s.cls() == Class::Tower || s.cls() == Class::Boss), |x, y| x.idx < y.idx) {
            return Some(i);
        }
    }
    if ac == Class::Artillery || ac == Class::Boss {
        return pick(enemy, ok, |x, y| x.count() > y.count() || (x.count() == y.count() && (x.row < y.row || (x.row == y.row && x.idx < y.idx))));
    }
    if ac == Class::Guardian {
        if let Some(i) = pick(enemy, |i, s| ok(i, s) && s.cls() == Class::Raider, |x, y| near(x, y) < 0) {
            return Some(i);
        }
    }
    pick(enemy, ok, |x, y| x.row < y.row || (x.row == y.row && near(x, y) < 0))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct BattleResult {
    pub attacker_won: bool,
    pub ticks: u32,
    /// per mille (the JS `destruction` is this / 10)
    pub destruction_pm: u32,
    pub survival_pm: u32,
    pub score: u32,
    /// attacker units lost, by unit index
    pub lost: [u32; UNIT_COUNT],
}

/// hit(): apply damage, with Revive. Returns the damage dealt.
fn hit(sides: &mut [Side; 2], team: usize, di: usize, amount: i64) -> i64 {
    let side = &mut sides[team];
    let dst_hp = side.slots[di].hp;
    let dealt = core::cmp::min(dst_hp, core::cmp::max(0, amount));
    side.slots[di].hp -= dealt;
    if side.slots[di].hp <= 0 {
        let support_alive = side.slots[..side.len].iter().any(|x| x.alive() && x.cls() == Class::Support);
        if side.has(REVIVE) && !side.revived && side.slots[di].idx < 9 && support_alive {
            side.revived = true;
            let hm = side.slots[di].hp_max;
            side.slots[di].hp = core::cmp::max(1, mul(hm, 2000));
            side.slots[di].pinned = true;
        }
    }
    dealt
}

/// Run a battle (simulate2). `attacker` is team 0, `defender` team 1.
pub fn simulate(attacker: &SideInput, defender: &SideInput, seed: u32) -> BattleResult {
    let mut rng = Rng::new(seed);
    // on the heap: Solana programs get a 4 KB stack frame and the two sides are ~2 KB
    let mut sides: Box<[Side; 2]> = Box::new([make_side(attacker), make_side(defender)]);
    let start: [i64; 2] = [0, 1].map(|t| sides[t].slots[..sides[t].len].iter().map(|s| s.hp_max).sum());
    let mut round: u32 = 1;
    while round <= ROUNDS {
        if !sides[0].any_alive() || !sides[1].any_alive() {
            break;
        }
        // turn order: (team, slot) of every living slot, sorted by class rank, alternating team, index
        let mut order: [(usize, usize); 2 * MAX_SLOTS] = [(0, 0); 2 * MAX_SLOTS];
        let mut olen = 0;
        for t in 0..2 {
            for i in 0..sides[t].len {
                if sides[t].slots[i].alive() {
                    order[olen] = (t, i);
                    olen += 1;
                }
            }
        }
        let key = |sides: &[Side; 2], (t, i): (usize, usize)| -> (i32, u32, u8) {
            let s = &sides[t].slots[i];
            let r = if s.cls() == Class::Ranger && sides[t].order == HOLD { -1 } else { rank_of(s.cls()) };
            (r, (t as u32 + round) % 2, s.idx)
        };
        // insertion sort (keys are unique)
        for x in 1..olen {
            let mut y = x;
            while y > 0 && key(&sides, order[y]) < key(&sides, order[y - 1]) {
                order.swap(y, y - 1);
                y -= 1;
            }
        }
        for &(t, ai) in order[..olen].iter() {
            if sides[t].slots[ai].hp <= 0 {
                continue;
            }
            let e = 1 - t;
            let a = sides[t].slots[ai];
            let my_order = sides[t].order;
            if round == 1 && my_order == HOLD && (a.cls() == Class::Raider || a.cls() == Class::Guardian) {
                continue;
            }
            let n = a.count();
            if a.cls() == Class::Support {
                let side = &sides[t];
                let hurt = pick(
                    side,
                    |_, s| s.alive() && s.hp < s.hp_max && lane_dist(s, &a) <= 1,
                    |x, y| x.hp_max - x.hp > y.hp_max - y.hp || (x.hp_max - x.hp == y.hp_max - y.hp && x.idx < y.idx),
                );
                if let Some(hi) = hurt {
                    let s = &mut sides[t].slots[hi];
                    let h = core::cmp::min(s.hp_max - s.hp, n * a.heal);
                    s.hp += h;
                    continue;
                }
            }
            if sides[t].slots[ai].pinned {
                sides[t].slots[ai].pinned = false;
                continue;
            }
            let Some(tgt) = choose_target(&a, my_order, &sides[e], round, None) else { break };
            strike(&mut sides, &mut rng, t, ai, n, tgt, B);
            if a.cls() == Class::Ranger && sides[t].has(VOLLEY) && sides[t].slots[ai].hp > 0 {
                let a_now = sides[t].slots[ai];
                if let Some(second) = choose_target(&a_now, my_order, &sides[e], round, Some(tgt)) {
                    strike(&mut sides, &mut rng, t, ai, n, second, 2500);
                }
            }
            if round == 1 && a.cls() == Class::Raider && sides[t].has(FIRSTSTRIKE) && sides[t].slots[ai].hp > 0 {
                let a_now = sides[t].slots[ai];
                if let Some(again) = choose_target(&a_now, my_order, &sides[e], round, None) {
                    strike(&mut sides, &mut rng, t, ai, n, again, 3500);
                }
            }
            if !sides[e].any_alive() {
                break;
            }
        }
        round += 1;
    }

    let end: [i64; 2] = [0, 1].map(|t| sides[t].slots[..sides[t].len].iter().map(|s| core::cmp::max(0, s.hp)).sum());
    let attacker_won = !sides[1].any_alive();
    let destruction_pm = if start[1] > 0 { 1000 - (end[1] * 1000) / start[1] } else { 1000 };
    let survival_pm = if start[0] > 0 { (end[0] * 1000) / start[0] } else { 0 };
    let mut lost = [0u32; UNIT_COUNT];
    for s in sides[0].slots[..sides[0].len].iter() {
        let l = s.n0 - s.count();
        if l > 0 && (s.unit as usize) < UNIT_COUNT {
            lost[s.unit as usize] += l as u32;
        }
    }
    BattleResult {
        attacker_won,
        ticks: core::cmp::min(round, ROUNDS),
        destruction_pm: destruction_pm as u32,
        survival_pm: survival_pm as u32,
        score: (destruction_pm + if attacker_won { 300 } else { 0 } + survival_pm / 5) as u32,
        lost,
    }
}

/// One attack (the `strike` closure in the JS engine).
fn strike(sides: &mut [Side; 2], rng: &mut Rng, t: usize, ai: usize, n: i64, ti: usize, scale: i64) {
    let e = 1 - t;
    let a = sides[t].slots[ai];
    let tgt = sides[e].slots[ti];
    let ac = a.cls();
    let tc = tgt.cls();
    let my_order = sides[t].order;
    let mut d = n * a.atk;
    if scale != B {
        d = mul(d, scale);
    }
    let mut counter = if tc == Class::Boss && (a.unit == SIEGE || a.unit == TANK) { BOSS_COUNTER_BPS } else { counter_of(ac, tc) };
    if ac == Class::Artillery && sides[t].has(SIEGEBREAKER) && (tc == Class::Tower || tc == Class::Boss) {
        counter *= 2;
    }
    d = mul(d, counter);
    let is_exposed = exposed(&sides[e], &tgt);
    let mut atk_bonus = 0;
    let mut order_bonus = 0;
    if ac == Class::Artillery {
        atk_bonus += core::cmp::min(CLUSTER_MAX_BPS, CLUSTER_BPS_PER_10 * (tgt.count() / 10));
    }
    order_bonus += order_dmg(my_order);
    if my_order == FLANK {
        order_bonus += if ac == Class::Raider { if is_exposed { 1500 } else { 0 } } else { -1000 };
    }
    if my_order == FOCUS {
        order_bonus += 500;
    }
    let rallied = sides[t].has(RALLY) && sides[t].slots[..sides[t].len].iter().any(|x| x.alive() && x.cls() == Class::Support && x.lane == a.lane);
    if rallied {
        atk_bonus += 1500;
    }
    d = mul(d, B + atk_bonus + order_bonus);
    d = mul(d, ROLL_MIN + (rng.next() as i64 % (ROLL_MAX - ROLL_MIN + 1)));
    let exp_bonus = if is_exposed { EXPOSED_BPS + if ac == Class::Ranger { RANGER_EXPOSED_BPS } else { 0 } } else { 0 };
    d = mul(d, B + exp_bonus);
    let e_order = sides[e].order;
    let aura = if sides[e].slots[..sides[e].len].iter().any(|s| s.alive() && s.cls() == Class::Support && lane_dist(s, &tgt) <= 1) { AURA_BPS } else { 0 };
    let taken_bps = core::cmp::max(1000, B + order_taken(e_order) - aura);
    d = mul(d, taken_bps);
    // Guardians in front, in the same lane, take part of the blow
    let penetrates = ac == Class::Raider && a.lane != 1;
    let ambush = penetrates && sides[t].has(AMBUSH);
    if tgt.row > 0 && tc != Class::Guardian && !ambush {
        let guard = pick(
            &sides[e],
            |_, s| s.alive() && s.cls() == Class::Guardian && s.lane == tgt.lane && s.row < tgt.row,
            |x, y| x.intercept > y.intercept || (x.intercept == y.intercept && x.row < y.row),
        );
        if let Some(gi) = guard {
            let mut share = sides[e].slots[gi].intercept + if e_order == HOLD { HOLD_INTERCEPT_BPS } else { 0 };
            if penetrates {
                share /= 2;
            }
            let part = mul(d, share);
            let counter_vs_guard = counter_of(ac, Class::Guardian);
            let mut guard_part = (part * counter_vs_guard) / counter;
            if exp_bonus != 0 {
                guard_part = (guard_part * B) / (B + exp_bonus);
            }
            hit(sides, e, gi, guard_part);
            d -= part;
        }
    }
    hit(sides, e, ti, d);
    if ac == Class::Ranger && tc == Class::Raider && sides[e].slots[ti].hp > 0 && sides[t].has(PINNING) && !sides[e].slots[ti].pinned {
        sides[e].slots[ti].pinned = true;
    }
    if a.splash > 0 {
        let row = tgt.row;
        let bombard = sides[t].has(BOMBARDMENT);
        let sd = if bombard { mul(d, 5000) } else { mul(d, a.splash) };
        for si in 0..sides[e].len {
            let s = sides[e].slots[si];
            if !s.alive() || si == ti || s.row != row || s.idx >= 9 {
                continue;
            }
            if !bombard && lane_dist(&s, &tgt) != 1 {
                continue;
            }
            hit(sides, e, si, sd);
        }
    }
}
