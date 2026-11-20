//! The Rust engine must match the JavaScript engine exactly. `vectors.json` is written by
//! `npx tsx scripts/battle-vectors.ts` from shared/battle2.js.
use serde::Deserialize;
use stakeclash_battle::{simulate, BattleResult, Champion, SideInput, UNIT_COUNT};

#[derive(Deserialize)]
struct VChampion {
    hp: u32,
    atk: u32,
    splash: bool,
}
#[derive(Deserialize)]
struct VSide {
    slots: Vec<(u8, u16)>,
    order: u8,
    abilities: Vec<u8>,
    levels: Vec<u8>,
    boosts: Vec<i32>,
    vigor: Vec<i32>,
    towers: u8,
    champion: Option<VChampion>,
}
#[derive(Deserialize)]
struct VExpect {
    attacker_won: bool,
    ticks: u32,
    destruction_pm: u32,
    survival_pm: u32,
    score: u32,
    lost: Vec<u32>,
}
#[derive(Deserialize)]
struct Vector {
    seed: u32,
    attacker: VSide,
    defender: VSide,
    expect: VExpect,
}

fn side(v: &VSide) -> SideInput {
    let mut s = SideInput::default();
    for (i, x) in v.slots.iter().enumerate() {
        s.slots[i] = *x;
    }
    s.order = v.order;
    s.abilities = [v.abilities[0], v.abilities[1]];
    s.levels.copy_from_slice(&v.levels[..UNIT_COUNT]);
    s.boosts.copy_from_slice(&v.boosts[..UNIT_COUNT + 1]);
    s.vigor.copy_from_slice(&v.vigor[..UNIT_COUNT + 1]);
    s.towers = v.towers;
    s.champion = v.champion.as_ref().map(|c| Champion { hp: c.hp, atk: c.atk, splash: c.splash });
    s
}

#[test]
fn matches_the_javascript_engine() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors.json")).expect("run scripts/battle-vectors.ts first");
    let vectors: Vec<Vector> = serde_json::from_str(&raw).unwrap();
    assert!(vectors.len() >= 100);
    let mut bad = 0;
    for (i, v) in vectors.iter().enumerate() {
        let got = simulate(&side(&v.attacker), &side(&v.defender), v.seed);
        let e = &v.expect;
        let want = BattleResult {
            attacker_won: e.attacker_won,
            ticks: e.ticks,
            destruction_pm: e.destruction_pm,
            survival_pm: e.survival_pm,
            score: e.score,
            lost: [e.lost[0], e.lost[1], e.lost[2], e.lost[3], e.lost[4], e.lost[5]],
        };
        if got != want {
            bad += 1;
            if bad <= 5 {
                eprintln!("vector {i} (seed {}): got {got:?}\n  want {want:?}", v.seed);
            }
        }
    }
    assert_eq!(bad, 0, "{bad} of {} battles differ from the JavaScript engine", vectors.len());
}

#[test]
fn rng_matches_xorshift32() {
    // first outputs of the JS generator for seed 1
    let mut r = stakeclash_battle::Rng::new(1);
    assert_eq!(r.next(), 270369);
    assert_eq!(r.next(), 67634689);
}
