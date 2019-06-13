// NOTE: A portion of these code was ripped from https://github.com/ppy/osu and https://github.com/ppy/osu-performance

var opened_file = "";
var beatmap_data = {
    od: 0,
    stars_ht: 0,
    stars_nt: 0,
    stars_dt: 0,
    note_count: 0
};
var values_changed = true;

// Show message as a modal dialog
function show_message(msg, title) {
    document.getElementById("msg").innerHTML = msg;
    document.getElementById("msg-title").innerHTML = title;
    const dialog = new mdc.dialog.MDCDialog(document.getElementById("msg-dialog"));
    dialog.show();
}

// Show "Load beatmap from path" dialog
function show_file_dialog() {
    const dialog = new mdc.dialog.MDCDialog(document.getElementById("file-dialog"));
    dialog.show();
    // reset chosen file
    document.getElementById("file-input").value = "";
    change_file();
    opened_file = "";
}

// get mods that the user selected
function get_mods() {
    return {
        dt: document.getElementById("mod-dt").checked,
        ez: document.getElementById("mod-ez").checked,
        nf: document.getElementById("mod-nf").checked,
        ht: document.getElementById("mod-ht").checked
    };
}

// update the values according to loaded beatmap
function update_fields() {
    const mods = get_mods();
    document.getElementById("od-field").value = mods.ez ? beatmap_data.od * 0.5 : beatmap_data.od;
    document.getElementById("n-field").value = beatmap_data.note_count;
    document.getElementById("stars-field").value = (mods.dt ? beatmap_data.stars_dt : (mods.ht ? beatmap_data.stars_ht : beatmap_data.stars_nt)).toFixed(2);
    // refresh their styles
    document.getElementById("od-field").dispatchEvent(new Event("blur"));
    document.getElementById("n-field").dispatchEvent(new Event("blur"));
    document.getElementById("stars-field").dispatchEvent(new Event("blur"));
}

// When user selects/deselects a mod
function select_mod(mod) {
    // HT and DT can"t be toggled on simultaneously
    const dt_element = document.getElementById("mod-dt");
    const ht_element = document.getElementById("mod-ht");
    if(mod == "dt") {
        if(dt_element.checked) {
            ht_element.checked = "";
        }
    }
    if(mod == "ht") {
        if(ht_element.checked) {
            dt_element.checked = "";
        }
    }
    if(!values_changed) update_fields();
}

// returns n-th capture group from matching regex
function capture(str, regex, index=1) {
    if(str.match(regex)){
        var res = regex.exec(str);
        return res[index];
    } else {
        return "";
    }
}

// Returns an osu!mania note from note entry
function parse_note(line, keys) {
    // Line format:
    //     x,y,time,type,hitSound,endTime:extras...
    // where all numbers are integers
    line_regex = /(\d+),\d+,(\d+),\d+,\d+,(\d+)/g;

    var x = parseInt(capture(line, line_regex, 1)),
        start_t = parseInt(capture(line, line_regex, 2)),
        end_t = parseInt(capture(line, line_regex, 3)),
        key = Math.floor(x * keys / 512);

    // non-LN's don't have end times
    end_t = end_t ? end_t : start_t;

    return {
        key: key,
        start_t: start_t,
        end_t: end_t,
        overall_strain: 1,
        individual_strain: new Array(keys).fill(0)
    };
}

// get star rate of given notes
function get_star_rate(notes, keys, time_scale) {
    // constants
    const strain_step = 400 * time_scale, weight_decay_base = 0.9, individual_decay_base = 0.125, overall_decay_base = 0.3, star_scaling_factor = 0.018;

    // get strain for each note
    var held_until = new Array(keys).fill(0);
    var previous_note = false;
    notes.forEach((note) => {
        if(!previous_note) {
            previous_note = note;
            return;
        }

        const time_elapsed = (note.start_t - previous_note.start_t) / time_scale / 1000;
        const individual_decay = individual_decay_base ** time_elapsed;
        const overall_decay = overall_decay_base ** time_elapsed;
        var hold_factor = 1, hold_addition = 0;

        for(var i = 0; i < keys; i++) {
            if(note.start_t < held_until[i] && note.end_t > held_until[i]) {
                hold_addition = 1;
            } else if(note.end_t == held_until[i]) {
                hold_addition = 0;
            } else if(note.end_t < held_until[i]) {
                hold_factor = 1.25;
            }
            note.individual_strain[i] = previous_note.individual_strain[i] * individual_decay;
        }
        held_until[note.key] = note.end_t;

        note.individual_strain[note.key] += 2 * hold_factor;
        note.overall_strain = previous_note.overall_strain * overall_decay + (1 + hold_addition) * hold_factor;

        previous_note = note;
    });

    // get difficulty for each interval
    var strain_table = [], max_strain = 0, interval_end_time = strain_step;
    var previous_note = false;
    notes.forEach((note) => {
        while(note.start_t > interval_end_time) {
            strain_table.push(max_strain);
            if(!previous_note) {
                max_strain = 0;
            } else {
                const individual_decay = individual_decay_base ** ((interval_end_time - previous_note.start_t) / 1000);
                const overall_decay = overall_decay_base ** ((interval_end_time - previous_note.start_t) / 1000);
                max_strain = previous_note.individual_strain[previous_note.key] * individual_decay + previous_note.overall_strain * overall_decay;
            }
            interval_end_time += strain_step;
        }
        const strain = note.individual_strain[note.key] + note.overall_strain;
        if(strain > max_strain) max_strain = strain;
        previous_note = note;
    });

    // get total difficulty
    var difficulty = 0, weight = 1;
    strain_table.sort((x, y) => {return y - x});
    for(var i = 0; i < strain_table.length; i++) {
        difficulty += strain_table[i] * weight;
        weight *= weight_decay_base;
    }
    return difficulty * star_scaling_factor;
}

// Parse .osu file
function parse_data(file_content, mods) {
    try {
        const content_lines = file_content.split("\n");
        var gamemode, od, keys, notes = [];

        var section_name;
        content_lines.forEach((line) => {
            // omit empty lines and comments
            if(line == "" || line.match(/\/\/.*/g)) return;
            // if is start of section
            if(line.match(/\[(.*)\]/g)) {
                section_name = capture(line, /\[(.*)\]/g);
                return;
            }
            // difficulty data section
            if(section_name == "Difficulty") {
                // get key count and od
                if(line.match(/CircleSize:(.*)/g)) {
                    keys = parseInt(capture(line, /CircleSize:(.*)/g));
                }
                if(line.match(/OverallDifficulty:(.*)/g)) {
                    od = parseInt(capture(line, /OverallDifficulty:(.*)/g));
                }
            }
            // hitobjects section
            if(section_name == "HitObjects") {
                notes.push(parse_note(line, keys));
            }
        });

        // sort notes by time
        notes.sort((x, y) => {return x.start_t - y.start_t});

        return {notes, keys, od};
    } catch(e) {
        show_message("An error occurred while parsing your file. If you believe that the file is valid, please contact the developer.", "Error");
    }
}

// Load .osu file data, calculate the values and fill them in their respective fields
function load_data(file_content) {
    // get mods
    const mods = get_mods();
    const data = parse_data(file_content, mods);
    const star_rate_ht = get_star_rate(data.notes, data.keys, 0.75);
    const star_rate_nt = get_star_rate(data.notes, data.keys, 1);
    const star_rate_dt = get_star_rate(data.notes, data.keys, 1.5);
    // update values
    beatmap_data = {
        od: data.od,
        stars_ht: star_rate_ht,
        stars_nt: star_rate_nt,
        stars_dt: star_rate_dt,
        note_count: data.notes.length
    };
    values_changed = false;
    update_fields();
}

// Attempt to load and parse .osu file or url
function load_osufile() {
    var file_content = "";
    const osu_url = document.getElementById("url-field").value;

    if(opened_file != "") {
        // attempt to read selected file
        var reader = new FileReader();
        reader.onload = () => {
            file_content = reader.result;
            load_data(file_content);
        };
        reader.readAsText(opened_file);
    } else if(osu_url.match(/^\d+$/g)) {
        // get file from id
        fetch("/fetch_osu.php?id=" + osu_url)
            .then(response => response.text())
            .then((data) => {
                file_content = data;
                load_data(file_content);
            });
    } else if(osu_url.match(/osu\.ppy\.sh.*\/\d+$/g)) {
        // get file from url
        fetch("/fetch_osu.php?id=" + capture(osu_url, /osu\.ppy\.sh.*\/(\d+)$/g))
            .then(response => response.text())
            .then((data) => {
                file_content = data;
                load_data(file_content);
            });
    } else {
        // no file to read
        return;
    }
}

// get pp from values
function get_pp(stars, score, od, note_count) {
    const mods = get_mods();
    var score_rate = 1;
    if(mods.ez) score_rate *= 0.5;
    if(mods.nf) score_rate *= 0.5;
    if(mods.ht) score_rate *= 0.5;
    const real_score = score / score_rate;
    if(real_score > 1000000) return NaN;

    var hit300_window = 34 + 3 * (Math.min(10, Math.max(0, 10 - od)));
    var strain_value = (5 * Math.max(1, stars / 0.2) - 4) ** 2.2 / 135 * (1 + 0.1 * Math.min(1, note_count / 1500));
    if(real_score <= 500000) {
        strain_value = 0;
    } else if(real_score <= 600000) {
        strain_value *= ((real_score - 500000) / 100000 * 0.3);
    } else if(real_score <= 700000) {
        strain_value *= (0.3 + (real_score - 600000) / 100000 * 0.25);
    } else if(real_score <= 800000) {
        strain_value *= (0.55 + (real_score - 700000) / 100000 * 0.20);
    } else if(real_score <= 900000) {
        strain_value *= (0.75 + (real_score - 800000) / 100000 * 0.15);
    } else {
        strain_value *= (0.9 + (real_score - 900000) / 100000 * 0.1);
    }

    var acc_value = Math.max(0, 0.2 - ((hit300_window - 34) * 0.006667)) * strain_value * (Math.max(0, real_score - 960000) / 40000) ** 1.1;

    var pp_multiplier = 0.8;
    if(mods.nf) pp_multiplier *= 0.9;
    if(mods.ez) pp_multiplier *= 0.5;

    return (strain_value ** 1.1 + acc_value ** 1.1) ** (1 / 1.1) * pp_multiplier;
}

// display pp as "That's about %d pp"
function display_pp() {
    const stars = parseFloat(document.getElementById("stars-field").value);
    const od = parseInt(document.getElementById("od-field").value);
    const note_count = parseInt(document.getElementById("n-field").value);
    const score = parseInt(document.getElementById("score-field").value);
    document.getElementById("results").innerHTML = "That's about " + get_pp(stars, score, od, note_count).toFixed(0) + " pp.";
}

// Change the file to load
function update_file(file) {
    var file_button = document.getElementById("file-button");
    document.getElementById("filename").innerHTML = file.name;
    file_button.innerHTML = "open file";
    file_button.className = "mat-button mdc-button mdc-button--raised blue-button";
    mdc.ripple.MDCRipple.attachTo(file_button);
    opened_file = file;
}

// Called when file is changed
function change_file() {
    const file_button = document.getElementById("file-button");
    const file_input = document.getElementById("file-input");
    if(file_input.value == "") {
        document.getElementById("filename").innerHTML = "No .osu file selected";
        file_button.innerHTML = "open file";
        file_button.className = "mat-button mdc-button mdc-button--raised gray-button";
        mdc.ripple.MDCRipple.attachTo(file_button);
        return false;
    }

    var filename = file_input.value;
    const last_index = filename.lastIndexOf("\\");
    if (last_index >= 0) {
        filename = filename.substring(last_index + 1);
        document.getElementById("filename").innerHTML = filename;
        file_button.innerHTML = "open file";
        file_button.className = "mat-button mdc-button mdc-button--raised blue-button";
        mdc.ripple.MDCRipple.attachTo(file_button);
        update_file(file_input.files[0]);
    }
}

window.onload = function() {
    // attach a ripple to each button
    document.querySelectorAll(".mdc-button").forEach(
        (btn) => {const rip = new mdc.ripple.MDCRipple(btn);}
    );
    // instantiate every text field
    document.querySelectorAll(".mdc-text-field").forEach(
        (tf) => {const txt = new mdc.textField.MDCTextField(tf);}
    );

    // add drap-drop listeners
    document.body.addEventListener("dragover", (e) => {
        e.stopPropagation();
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    });
    document.body.addEventListener("dragenter", (e) => {
        e.stopPropagation();
        e.preventDefault();
    });
    document.body.addEventListener("drop", (e) => {
        e.stopPropagation();
        e.preventDefault();
        var files = e.dataTransfer.files;
        update_file(files[0]);
    });

    // add click listeners
    document.getElementById("open-file-link").onclick = show_file_dialog;
    document.getElementById("calculate-button").onclick = display_pp;
    document.getElementById("info-button").onclick = () => {
        show_message("This tool calculates the approximate pp you get based on the input values. Alternatively, you can get the values from selecting a .osu file(converted maps NOT supported!). Note there may be minor differences between star ratings displayed in-game, on the beatmap page and calculated by this app, so the pp you get may have a slight variation(Use the star rating on the beatmap listing page for accurate pp).", "Info");
    };
    document.getElementById("load-button").onclick = load_osufile;

    // add misc. listeners
    document.getElementById("mod-dt").onchange = () => {
        select_mod("dt");
    };
    document.getElementById("mod-ht").onchange = () => {
        select_mod("ht");
    };
    document.getElementById("mod-ez").onchange = () => {
        select_mod("ez");
    };
    document.getElementById("file-input").onchange = change_file;
    document.getElementById("od-field").onchange = () => {
        values_changed = true;
    };
    document.getElementById("n-field").onchange = () => {
        values_changed = true;
    };
    document.getElementById("stars-field").onchange = () => {
        values_changed = true;
    };
}
