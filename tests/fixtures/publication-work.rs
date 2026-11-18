// Native companion to publication-capture-index.test.ts. Run in the assigned
// execution guest against the qualified Turso core; JSON contains the actual
// captured owner statements and fresh schema, not a hand-maintained SQL copy.
// --scan removes the input casts as a mutation proof of the work-count guard.
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
    db.execute("BEGIN").unwrap();
    for n in 0..count {
        db.execute(format!(r#"
INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES('$old{n}','!old{n}',1,'accepted','grounded',{n});
INSERT INTO relations VALUES('$relation{n}','$old{n}','m.thread','!old{n}',{n});
INSERT INTO notification_receipt_refs VALUES('@old{n}','!old{n}','main','$old{n}');
INSERT INTO push_evaluations VALUES('test','@old{n}','$old{n}','!old{n}',{n},'room',1,0,0,1,NULL,NULL);
INSERT INTO notification_own_events VALUES('!old{n}','$old{n}','@old{n}',{n});
INSERT INTO redactions VALUES('$old{n}','!old{n}','$redaction{n}',1);
INSERT INTO receipts VALUES('!old{n}','@old{n}','m.read','main','["$old{n}"]',0,{n});
INSERT INTO notification_horizons VALUES('@old{n}','!old{n}','main',{n});
INSERT INTO notification_graph_reads VALUES('@old{n}','!old{n}','main','$old{n}');
INSERT INTO notifications VALUES({n},'test','@old{n}','$old{n}','!old{n}',{n},'main','[]',0,0,NULL,0);
"#)).unwrap();
    }
    db.execute("COMMIT").unwrap();
    input["queries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|query| {
            let sql = query["sql"].as_str().unwrap();
            let sql = if scan {
                sql.replace("CAST(j.value AS TEXT)", "j.value")
                    .replace("CAST(e.value AS TEXT)", "e.value")
                    .replace(
                        "CAST(json_extract(j.value,'$.room') AS TEXT)",
                        "json_extract(j.value,'$.room')",
                    )
                    .replace(
                        "CAST(json_extract(j.value,'$.sender') AS TEXT)",
                        "json_extract(j.value,'$.sender')",
                    )
            } else {
                sql.to_string()
            };
            let mut stmt = db.prepare(sql).unwrap();
            for (at, value) in query["values"].as_array().unwrap().iter().enumerate() {
                stmt.bind_at(
                    (at + 1).try_into().unwrap(),
                    Value::build_text(value.as_str().unwrap().to_string()),
                )
                .unwrap();
            }
            stmt.run_ignore_rows().unwrap();
            let metrics = stmt.metrics();
            (metrics.rows_read, metrics.fullscan_steps)
        })
        .collect()
}

fn main() {
    let args: Vec<_> = env::args().collect();
    let input = serde_json::from_str(&fs::read_to_string(&args[1]).unwrap()).unwrap();
    let scan = args.iter().any(|s| s == "--scan");
    let small = measure(&input, 16, scan);
    let large = measure(&input, 1024, scan);
    let mut violations = Vec::new();
    for (at, (before, after)) in small.iter().zip(&large).enumerate() {
        println!(
            "query {at}: 16 facts {before:?}, 1024 facts {after:?} (rows_read, fullscan_steps)"
        );
        if after.0 > before.0 || after.1 > before.1 {
            violations.push(at);
        }
    }
    assert!(
        violations.is_empty(),
        "unrelated retained facts increased native work for queries {violations:?}"
    );
}
