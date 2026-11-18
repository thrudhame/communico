// Companion to sync-relevance-index.test.ts. Input is the captured production
// statement and actual schema. Run against the qualified native Turso core in
// the execution guest. --scan bypasses the keyed indexes for mutation proof.
use std::{env, fs, sync::Arc};
use turso_core::{Database, MemoryIO, SqliteDialect, Value};

fn measure(input: &serde_json::Value, count: usize, scan: bool) -> Vec<(u64, u64)> {
    let database = Database::open_file(
        Arc::new(MemoryIO::new()),
        ":memory:",
        Arc::new(SqliteDialect),
    )
    .unwrap();
    let db = database.connect().unwrap();
    db.execute("PRAGMA journal_mode=mvcc").unwrap();
    for sql in input["schema"].as_array().unwrap() {
        db.execute(sql.as_str().unwrap()).unwrap();
    }
    for sql in input["setup"].as_array().unwrap() {
        db.execute(sql.as_str().unwrap()).unwrap();
    }
    db.execute("BEGIN").unwrap();
    for n in 0..count {
        // Older history in a relevant room, newer unrelated feed, unrelated
        // memberships and older prejoin history cannot enlarge a no-change probe.
        db.execute(format!(r#"
INSERT INTO feed VALUES(-{n}-1,'!joined',-{n}-1,'$old{n}',1);
INSERT INTO feed VALUES({n}+1000,'!other',-{n}-1,'$other{n}',1);
INSERT INTO memberships VALUES('@other{n}','!joined','join','$member{n}',1);
INSERT INTO prejoin_memberships(room_id,user_id,event_id,room_version,event_json,invite_room_state,origin,received_ms,status,seq) VALUES('!prior{n}','@alice','$prior{n}','10','{{}}','[]','peer',0,'rejected',-{n}-1);
"#)).unwrap();
    }
    db.execute("COMMIT").unwrap();
    input["queries"].as_array().unwrap().iter().map(|query| {
        let sql = query["sql"].as_str().unwrap();
        // Use the same statement and cut while bypassing its keyed indexes.
        let sql = if scan {
            sql.replace("FROM feed f WHERE", "FROM feed f NOT INDEXED WHERE")
                .replace("FROM memberships m WHERE", "FROM memberships m NOT INDEXED WHERE")
                .replace("FROM prejoin_memberships p WHERE", "FROM prejoin_memberships p NOT INDEXED WHERE")
        } else { sql.to_string() };
        let mut stmt = db.prepare(sql).unwrap();
        for (at, value) in query["values"].as_array().unwrap().iter().enumerate() {
            stmt.bind_at((at + 1).try_into().unwrap(), match value {
                serde_json::Value::String(text) => Value::build_text(text.to_string()),
                serde_json::Value::Number(n) => Value::from_i64(n.as_i64().unwrap()),
                _ => panic!("unsupported bound value: {value}"),
            }).unwrap();
        }
        stmt.run_ignore_rows().unwrap();
        let metrics = stmt.metrics();
        (metrics.rows_read, metrics.fullscan_steps)
    }).collect()
}

fn main() {
    let args: Vec<_> = env::args().collect();
    let input = serde_json::from_str(&fs::read_to_string(&args[1]).unwrap()).unwrap();
    let scan = args.iter().any(|s| s == "--scan");
    let small = measure(&input, 16, scan);
    let large = measure(&input, 1024, scan);
    for (at, (before, after)) in small.iter().zip(&large).enumerate() {
        println!("query {at}: 16 facts {before:?}, 1024 facts {after:?} (rows_read, fullscan_steps)");
        assert!(after.0 <= before.0 && after.1 <= before.1,
            "retained history increased native relevance work");
    }
}
