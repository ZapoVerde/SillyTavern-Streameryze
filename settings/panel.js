/**
 * @file st-extensions/SillyTavern-Triggeryze/settings/panel.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role UI — settings panel shell (HTML, global checkboxes, panel wiring)
 * @description
 * Injects the Triggeryze drawer into ST's extensions settings area and wires the four
 * global checkboxes (enable, verbose, non-streaming, show-badges) and the add-rule
 * button. Rule rendering and profile management are delegated to rule-cards.js and
 * profiles.js respectively.
 *
 * @api-declaration
 * addSettingsPanel() — injects the drawer and wires all panel-level handlers
 *
 * @contract
 *   assertions:
 *     purity:          none — writes DOM; calls saveSettingsDebounced
 *     state_ownership: none (delegates to storage.js)
 *     external_io:     saveSettingsDebounced, reinjectAllBadges, removeAllBadges
 */

import { saveSettingsDebounced }                                            from '../../../../../script.js';
import { reinjectAllBadges, removeAllBadges }                               from '../badge.js';
import { getSettings, makeId }                                              from './storage.js';
import { refreshProfileDropdown, bindProfileHandlers, updateProfileDirtyIndicator } from './profiles.js';
import { renderRules, expandOnCreate }                                      from './rule-cards.js';

export async function addSettingsPanel() {
    $('#extensions_settings2').append(`
<div id="triggeryze_settings">
<div class="inline-drawer">
<div class="inline-drawer-toggle inline-drawer-header">
    <b>Triggeryze</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content">
    <label class="checkbox_label">
        <input type="checkbox" id="trg_enabled" />
        <span>Enable</span>
    </label>
    <label class="checkbox_label">
        <input type="checkbox" id="trg_verbose" />
        <span>Verbose logging</span>
    </label>
    <label class="checkbox_label">
        <input type="checkbox" id="trg_nonstreaming" />
        <span>Run on non-streaming responses</span>
    </label>
    <label class="checkbox_label">
        <input type="checkbox" id="trg_showbadges" />
        <span>Show status badge on messages</span>
    </label>
    <hr />
    <div class="trg-profile-bar">
        <select id="trg-profile-select" class="trg-profile-select"></select>
        <button id="trg-profile-save"   class="trg-btn-icon" title="Save rules to this profile"><i class="fa-solid fa-floppy-disk"></i></button>
        <button id="trg-profile-add"    class="trg-btn-icon" title="Save as new profile"><i class="fa-solid fa-plus"></i></button>
        <button id="trg-profile-rename" class="trg-btn-icon" title="Rename profile"><i class="fa-solid fa-pencil"></i></button>
        <button id="trg-profile-delete" class="trg-btn-icon" title="Delete profile"><i class="fa-solid fa-trash"></i></button>
        <span class="trg-profile-sep"></span>
        <button id="trg-profile-export" class="trg-btn-icon" title="Export current profile as JSON"><i class="fa-solid fa-file-export"></i></button>
        <button id="trg-profile-import" class="trg-btn-icon" title="Import profile or rule from JSON file"><i class="fa-solid fa-file-import"></i></button>
        <button id="trg-profile-paste"  class="trg-btn-icon" title="Paste JSON to import"><i class="fa-solid fa-paste"></i></button>
    </div>
    <div id="trg_rules_list"></div>
    <button id="trg_add_ruleset" class="menu_button"><i class="fa-solid fa-plus"></i> Add group</button>
    <div class="inline-drawer trg-ref-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>Variables and functions cheatsheet</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
    <div class="trg-ref-body">

        <div class="inline-drawer trg-ref-subdrawer">
        <div class="inline-drawer-toggle inline-drawer-header trg-ref-sub-hdr">
            Variables <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content trg-ref-sub-content">
            <p style="margin-bottom:4px">Click a chip above a prompt field to insert the token at the cursor.</p>
            <table class="trg-ref-table">
                <tr><td><span class="trg-var-chip trg-var-chip-sys" style="pointer-events:none">{{keyword}}</span></td><td>system variables — always available</td></tr>
                <tr><td><span class="trg-var-chip trg-var-chip-lb" style="pointer-events:none">{{lbContent...}}</span></td><td>lorebook query tokens</td></tr>
                <tr><td><span class="trg-var-chip trg-var-chip-ps" style="pointer-events:none">{{psContent...}}</span></td><td>live prompt layer query tokens (postMessage only)</td></tr>
                <tr><td><span class="trg-var-chip trg-var-chip-rule" style="pointer-events:none">{{myVar}}</span></td><td>variable from a prior action in <em>this</em> rule</td></tr>
                <tr><td><span class="trg-var-chip trg-var-chip-global" style="pointer-events:none">{{theirVar}}</span></td><td>variable from another rule in the same group</td></tr>
                <tr><td><span class="trg-var-chip trg-var-chip-gvar" style="pointer-events:none">{{$shared}}</span></td><td>$ global — readable across all groups</td></tr>
            </table>
            <p style="margin-top:6px;margin-bottom:2px;font-weight:bold;opacity:.7">System variables</p>
            <table class="trg-ref-table">
                <tr><td><span class="trg-help-eg">{{keyword}}</span></td><td>word or phrase that matched the trigger</td></tr>
                <tr><td><span class="trg-help-eg">{{up-to}}</span></td><td>all text before the keyword</td></tr>
                <tr><td><span class="trg-help-eg">{{paragraph}}</span></td><td>paragraph containing the keyword</td></tr>
                <tr><td><span class="trg-help-eg">{{message}}</span></td><td>full message text</td></tr>
                <tr><td><span class="trg-help-eg">{{history:2}}</span></td><td>last 2 turn-pairs of chat history — bare N is always a literal; use <span class="trg-help-eg">{{history:{{turns}}}}</span> for a variable</td></tr>
                <tr><td><span class="trg-help-eg">{{history:2:user}}</span></td><td>last 2 user messages; also :ai, :Name, :Glob*, :{{varName}}</td></tr>
                <tr><td><span class="trg-help-eg">{{char}}</span></td><td>character name</td></tr>
                <tr><td><span class="trg-help-eg">{{user}}</span></td><td>user name</td></tr>
                <tr><td><span class="trg-help-eg">{{chat_id}}</span></td><td>current chat file name (no extension) — stable per-chat identifier</td></tr>
                <tr><td><span class="trg-help-eg">{{highlighted}}</span></td><td>text selected when a badge button was clicked</td></tr>
            </table>
            <p style="margin-top:6px;opacity:.6;font-size:.9em">Rule variables (amber chips) are set by a prior action's <em>Save as</em> field. Cross-rule variables (purple chips) are set by an action in another rule that fired this turn. Both clear at the start of each generation.</p>
            <p style="margin-top:6px;margin-bottom:2px;font-weight:bold;opacity:.7">Math</p>
            <div class="trg-help-eg trg-ref-block">{{math: expr }}</div>
            <p>Evaluates arithmetic after all variable substitution. Combine with ST variable reads to compute new values.</p>
            <table class="trg-ref-table">
                <tr><td><span class="trg-help-eg">{{math: {{chatvar::hp}} - 15 }}</span></td><td>subtract 15 from chat variable hp</td></tr>
                <tr><td><span class="trg-help-eg">{{math: {{score}} * 2 + 10 }}</span></td><td>double a rule variable and add 10</td></tr>
                <tr><td><span class="trg-help-eg">{{math: {{chatvar::stats.gold}} / 4 }}</span></td><td>divide an object property</td></tr>
                <tr><td><span class="trg-help-eg">{{math: randint(1, 20) }}</span></td><td>d20 roll — random integer in [1, 20]</td></tr>
                <tr><td><span class="trg-help-eg">{{math: randint(1, 6) + randint(1, 6) }}</span></td><td>2d6 — two independent rolls summed</td></tr>
                <tr><td><span class="trg-help-eg">{{math: {{chatvar::hp}} - randint(1, 8) }}</span></td><td>subtract a random damage roll from hp</td></tr>
                <tr><td><span class="trg-help-eg">{{math: rand() }}</span></td><td>random float in [0, 1)</td></tr>
            </table>
            <p style="opacity:.6;font-size:.9em">Operators: <span class="trg-help-eg">+ - * / % **</span> and parentheses. Functions: <span class="trg-help-eg">rand()</span> → float [0,1) &nbsp;·&nbsp; <span class="trg-help-eg">randint(N, M)</span> → integer in [N, M]. Returns empty string on invalid input.</p>
        </div>
        </div>

        <div class="inline-drawer trg-ref-subdrawer">
        <div class="inline-drawer-toggle inline-drawer-header trg-ref-sub-hdr">
            String transforms <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content trg-ref-sub-content">
            <p>Transforms wrap a resolved value and run after all variable substitution. The inner value is typically a <span class="trg-help-eg">{{varName}}</span> or <span class="trg-help-eg">{{lbContent:...}}</span> token.</p>
            <table class="trg-ref-table">
                <tr><td><span class="trg-help-eg">{{trim: value}}</span></td><td>strip leading and trailing whitespace</td></tr>
                <tr><td><span class="trg-help-eg">{{upper: value}}</span></td><td>convert to UPPERCASE</td></tr>
                <tr><td><span class="trg-help-eg">{{lower: value}}</span></td><td>convert to lowercase</td></tr>
                <tr><td><span class="trg-help-eg">{{cap: value}}</span></td><td>capitalize first character</td></tr>
                <tr><td><span class="trg-help-eg">{{len: value}}</span></td><td>character count as a string</td></tr>
                <tr><td><span class="trg-help-eg">{{lines: N: value}}</span></td><td>first N lines</td></tr>
                <tr><td><span class="trg-help-eg">{{last: N: value}}</span></td><td>last N lines</td></tr>
                <tr><td><span class="trg-help-eg">{{nth: N: value}}</span></td><td>line N (1-based); empty if out of range</td></tr>
                <tr><td><span class="trg-help-eg">{{words: N: value}}</span></td><td>first N whitespace-separated words</td></tr>
                <tr><td><span class="trg-help-eg">{{chars: N: value}}</span></td><td>first N characters</td></tr>
                <tr><td><span class="trg-help-eg">{{join: delim: value}}</span></td><td>join non-empty lines with delimiter</td></tr>
                <tr><td><span class="trg-help-eg">{{replace: find: with: value}}</span></td><td>replace all occurrences of <em>find</em> with <em>with</em> (literal)</td></tr>
                <tr><td><span class="trg-help-eg">{{default: fallback: value}}</span></td><td>use <em>value</em> if non-empty, otherwise <em>fallback</em></td></tr>
                <tr><td><span class="trg-help-eg">{{bar: value: bucketSize: max}}</span></td><td>colon bar chart — 1 colon per full bucket, <span class="trg-help-eg">.</span> for &gt;20% remainder, <span class="trg-help-eg">+</span> on overflow</td></tr>
                <tr><td><span class="trg-help-eg">{{pick: N: value}}</span></td><td>N random non-empty lines, newline-joined</td></tr>
            </table>
            <table class="trg-ref-table" style="margin-top:6px">
                <tr><td><span class="trg-help-eg">{{trim: {{message}}}}</span></td><td>trimmed message text</td></tr>
                <tr><td><span class="trg-help-eg">{{upper: {{keyword}}}}</span></td><td>matched keyword in caps</td></tr>
                <tr><td><span class="trg-help-eg">{{cap: {{keyword}}}}</span></td><td>keyword with first letter capitalised</td></tr>
                <tr><td><span class="trg-help-eg">{{lines: 3: {{lbContent::Elara}}}}</span></td><td>first 3 lines of the Elara entry</td></tr>
                <tr><td><span class="trg-help-eg">{{last: 1: {{opts}}}}</span></td><td>last line of LLM output</td></tr>
                <tr><td><span class="trg-help-eg">{{nth: 2: {{opts}}}}</span></td><td>second line of LLM output</td></tr>
                <tr><td><span class="trg-help-eg">{{chars: 80: {{summary}}}}</span></td><td>first 80 characters of summary</td></tr>
                <tr><td><span class="trg-help-eg">{{words: 10: {{psContent}}}}</span></td><td>first 10 words of the first prompt slot</td></tr>
                <tr><td><span class="trg-help-eg">{{join: , : {{opts}}}}</span></td><td>collapse multi-line output to comma-separated</td></tr>
                <tr><td><span class="trg-help-eg">{{replace: [Char]: {{char}}: {{prompt}}}}</span></td><td>swap a placeholder for the character name</td></tr>
                <tr><td><span class="trg-help-eg">{{default: none: {{myVar}}}}</span></td><td>"none" if myVar is empty or unset</td></tr>
            </table>
            <p style="opacity:.6;font-size:.9em"><span class="trg-help-eg">join</span> one optional leading space is padding, the rest is the literal delimiter &nbsp;·&nbsp; <span class="trg-help-eg">replace</span> / <span class="trg-help-eg">default</span> arguments may not contain a colon</p>
        </div>
        </div>

        <div class="inline-drawer trg-ref-subdrawer">
        <div class="inline-drawer-toggle inline-drawer-header trg-ref-sub-hdr">
            Lorebook queries <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content trg-ref-sub-content">
            <p>All five positions are optional — trailing colons can be omitted. Empty position = wildcard (match all).</p>
            <div class="trg-help-eg trg-ref-block">{{lbContent:[lbname]:[titlename]:[keyname]:[mode]:[scope]}}<br>{{lbBooks:::::}} &nbsp; {{lbKeys:::::}} &nbsp; {{lbTitles:::::}}</div>
            <table class="trg-ref-table">
                <tr><td><span class="trg-help-eg">lbname</span></td><td>lorebook name to search in &nbsp;<em style="opacity:.5">(default: all lorebooks)</em></td></tr>
                <tr><td><span class="trg-help-eg">titlename</span></td><td>entry title to match &nbsp;<em style="opacity:.5">(default: any title)</em></td></tr>
                <tr><td><span class="trg-help-eg">keyname</span></td><td>activation key to match &nbsp;<em style="opacity:.5">(default: any key)</em></td></tr>
                <tr><td><span class="trg-help-eg">mode</span></td><td><strong><span class="trg-help-eg">first</span>(*)</strong> | <span class="trg-help-eg">last</span> | <span class="trg-help-eg">all</span> | <span class="trg-help-eg">rnd</span></td></tr>
                <tr><td><span class="trg-help-eg">scope</span></td><td><strong><span class="trg-help-eg">active</span>(*)</strong> | <span class="trg-help-eg">inactive</span> | <span class="trg-help-eg">all</span></td></tr>
            </table>
            <p><strong>Filter values:</strong> bare text = exact literal &nbsp;·&nbsp; <span class="trg-help-eg">A, B, C</span> = OR list (comma-separated) &nbsp;·&nbsp; <span class="trg-help-eg">{{varName}}</span> = turn variable &nbsp;·&nbsp; <span class="trg-help-eg">!pattern</span> = exclude &nbsp;·&nbsp; <span class="trg-help-eg">"quoted, literal"</span> = comma inside a value</p>
            <table class="trg-ref-table">
                <tr><td><span class="trg-help-eg">{{lbContent:...}}</span></td><td>entry content &nbsp;<em style="opacity:.5">mode default: first</em></td></tr>
                <tr><td><span class="trg-help-eg">{{lbTitles:...}}</span></td><td>comma-separated entry titles &nbsp;<em style="opacity:.5">mode default: all</em></td></tr>
                <tr><td><span class="trg-help-eg">{{lbKeys:...}}</span></td><td>comma-separated activation keys &nbsp;<em style="opacity:.5">mode default: all</em></td></tr>
                <tr><td><span class="trg-help-eg">{{lbBooks:...}}</span></td><td>comma-separated lorebook names containing matching entries &nbsp;<em style="opacity:.5">mode default: all</em></td></tr>
            </table>
            <table class="trg-ref-table" style="margin-top:6px">
                <tr><td><span class="trg-help-eg">{{lbContent::Elara}}</span></td><td>content of entry titled "Elara" (lb=any, key=any)</td></tr>
                <tr><td><span class="trg-help-eg">{{lbContent:::love}}</span></td><td>content of entry with activation key "love" (lb=any, title=any)</td></tr>
                <tr><td><span class="trg-help-eg">{{lbContent:MyLB::love}}</span></td><td>entry with key "love" in lorebook "MyLB"</td></tr>
                <tr><td><span class="trg-help-eg">{{lbContent::{{nameVar}}}}</span></td><td>entry titled by turn variable <span class="trg-help-eg">nameVar</span></td></tr>
                <tr><td><span class="trg-help-eg">{{lbTitles}}</span></td><td>all active entry titles</td></tr>
                <tr><td><span class="trg-help-eg">{{lbBooks}}</span></td><td>names of all active lorebooks</td></tr>
                <tr><td><span class="trg-help-eg">{{lbBooks:::love}}</span></td><td>which lorebooks have an entry with key "love"</td></tr>
                <tr><td><span class="trg-help-eg">{{lbContent::::all}}</span></td><td>all entry contents joined with blank lines</td></tr>
                <tr><td><span class="trg-help-eg">{{lbContent:::::all}}</span></td><td>all entry contents including inactive entries</td></tr>
                <tr><td><span class="trg-help-eg">{{lbContent::::rnd}}</span></td><td>one randomly chosen entry's content</td></tr>
                <tr><td><span class="trg-help-eg">{{lbTitles::::rnd}}</span></td><td>one randomly chosen entry title</td></tr>
            </table>
            <p style="opacity:.6;font-size:.9em">Keyword fields also support lb tokens and <span class="trg-help-eg">{{varName}}</span> expansion.</p>
        </div>
        </div>

        <div class="inline-drawer trg-ref-subdrawer">
        <div class="inline-drawer-toggle inline-drawer-header trg-ref-sub-hdr">
            Live Prompt Layer queries <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content trg-ref-sub-content">
            <p>Surface the exact context stack sent to the LLM for the last generation. Resolves at <strong>postMessage</strong> stage only — produces no output during streaming.</p>
            <div class="trg-help-eg trg-ref-block">{{psName:nameFilter:mode}}<br>{{psContent:nameFilter:mode}}</div>
            <table class="trg-ref-table">
                <tr><td><span class="trg-help-eg">nameFilter</span></td><td>which slots to include &nbsp;<em style="opacity:.5">(default: all)</em></td></tr>
                <tr><td><span class="trg-help-eg">mode</span></td><td><span class="trg-help-eg">first</span> | <span class="trg-help-eg">last</span> | <span class="trg-help-eg">all</span></td></tr>
            </table>
            <p><strong>Filter forms:</strong> bare text = exact identifier or display name &nbsp;·&nbsp; <span class="trg-help-eg">world*</span> glob &nbsp;·&nbsp; <span class="trg-help-eg">{{varName}}</span> = turn variable &nbsp;·&nbsp; <span class="trg-help-eg">!pattern</span> = exclude</p>
            <p><strong>Mode defaults:</strong> <span class="trg-help-eg">psName</span> defaults to <strong><span class="trg-help-eg">all</span>(*)</strong> (newline-separated names) &nbsp;·&nbsp; <span class="trg-help-eg">psContent</span> defaults to <strong><span class="trg-help-eg">first</span>(*)</strong></p>
            <table class="trg-ref-table" style="margin-top:6px">
                <tr><td><span class="trg-help-eg">{{psName}}</span></td><td>all slot names, one per line</td></tr>
                <tr><td><span class="trg-help-eg">{{psContent}}</span></td><td>content of the first slot</td></tr>
                <tr><td><span class="trg-help-eg">{{psContent:worldInfoBefore}}</span></td><td>World Info Before content</td></tr>
                <tr><td><span class="trg-help-eg">{{psContent:my_rag_slot}}</span></td><td>named slot content by identifier</td></tr>
                <tr><td><span class="trg-help-eg">{{psName:world*}}</span></td><td>names of all worldInfo* slots</td></tr>
                <tr><td><span class="trg-help-eg">{{psContent:world*:all}}</span></td><td>all worldInfo slot contents joined with blank lines</td></tr>
                <tr><td><span class="trg-help-eg">{{psContent::all}}</span></td><td>full context stack, every slot joined with blank lines</td></tr>
                <tr><td><span class="trg-help-eg">{{psContent:{{mySlot}}}}</span></td><td>slot whose identifier or name is stored in turn variable <span class="trg-help-eg">mySlot</span></td></tr>
                <tr><td><span class="trg-help-eg">{{psRows}}</span></td><td>all slots as tab-separated <em>identifier↦charCount</em> rows — use with {{mapLines}}</td></tr>
                <tr><td><span class="trg-help-eg">{{psRows:world*}}</span></td><td>filtered subset as TSV rows (same filter syntax as psName/psContent)</td></tr>
                <tr><td><span class="trg-help-eg">{{psRows:!chatHistory*}}</span></td><td>all slots <em>except</em> those matching the exclusion pattern</td></tr>
                <tr><td><span class="trg-help-eg">{{psRows:!chatHistory*:sub=chatHistory-*>Chat History>@oaiConvChars}}</span></td><td>collapse matching rows into one aggregate row: <em>matchFilter&gt;label&gt;sumFilter</em>; use <em>@oaiConvChars</em> for windowed char count</td></tr>
                <tr><td><span class="trg-help-eg">{{psMaxNameLen:nameFilter}}</span></td><td>length of the longest display name among matching slots — use with <em>{{pad:N:}}</em> for column alignment</td></tr>
                <tr><td><span class="trg-help-eg">{{psCharSum:nameFilter}}</span></td><td>sum of character counts for matching slots, as an integer</td></tr>
            </table>
        </div>
        </div>

        <div class="inline-drawer trg-ref-subdrawer">
        <div class="inline-drawer-toggle inline-drawer-header trg-ref-sub-hdr">
            Data mapping <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content trg-ref-sub-content">
            <table class="trg-ref-table" style="margin-bottom:10px">
                <tr><td><span class="trg-help-eg">{{uuid}}</span></td><td>globally unique ID — a new v4 UUID on every call; store with <em>Save as</em> to reuse</td></tr>
            </table>
            <div style="border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:8px 10px">
                <p style="margin:0 0 6px;font-weight:bold;opacity:.7;font-size:.9em">Map blocks</p>
                <p style="margin:0 0 6px">Run a template body over every row of multi-column data — one output line per input row. Works with any turn variable or <span class="trg-help-eg">chatvar::</span> / <span class="trg-help-eg">globalvar::</span> sources.</p>
                <div class="trg-help-eg trg-ref-block">{{mapLines: delimiter : source}}<br>{{.1}} and {{.2}} are column references<br>{{/mapLines}}</div>
                <table class="trg-ref-table" style="margin-top:6px">
                    <tr><td><span class="trg-help-eg">delimiter</span></td><td><span class="trg-help-eg">\t</span> for tab, <span class="trg-help-eg">,</span> for comma, etc.</td></tr>
                    <tr><td><span class="trg-help-eg">source</span></td><td>turn variable name, <span class="trg-help-eg">chatvar::name</span>, or <span class="trg-help-eg">globalvar::name</span></td></tr>
                    <tr><td><span class="trg-help-eg">{{.1}}, {{.2}}, …</span></td><td>column references (1-based); empty string if column is missing</td></tr>
                </table>
                <p style="margin:6px 0 2px"><strong>Two-step workflow</strong> — capture data into a turn variable first, then map over it:</p>
                <table class="trg-ref-table trg-ref-examples">
                    <tr><td><em>compose "ps_rows"</em> → <span class="trg-help-eg">{{psRows}}</span></td></tr>
                    <tr><td><em>compose "layer_bars"</em> → <span class="trg-help-eg">{{mapLines: \t : ps_rows}}{{.1}} {{bar: {{.2}} : 4000 : 20}}{{/mapLines}}</span></td></tr>
                </table>
                <p style="opacity:.6;font-size:.9em;margin:6px 0 0">Blank lines in the source are skipped. Output is newline-joined rows — pair with a badge trigger's <span class="trg-help-eg">split-on: \n</span> to create one badge per row.</p>
            </div>
        </div>
        </div>

        <div class="inline-drawer trg-ref-subdrawer">
        <div class="inline-drawer-toggle inline-drawer-header trg-ref-sub-hdr">
            Conditionals <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content trg-ref-sub-content">
            <div class="trg-help-eg trg-ref-block">{{if condition}}body{{/if}}</div>
            <p>Condition uses bare variable names — no <span class="trg-help-eg">{{}}</span> around them. Body may contain <span class="trg-help-eg">{{variable}}</span> substitutions. Blocks can be stacked but not nested.</p>
            <table class="trg-ref-table">
                <tr><td><span class="trg-help-eg">name matches "pattern"</span></td><td>regex test, case-insensitive. <span class="trg-help-eg">|</span> for alternation.</td></tr>
                <tr><td><span class="trg-help-eg">name contains "text"</span></td><td>substring — true if value includes text anywhere</td></tr>
                <tr><td><span class="trg-help-eg">name is "value"</span></td><td>exact whole-word match</td></tr>
                <tr><td><span class="trg-help-eg">name in (a, b, c)</span></td><td>true if value equals any item in the list</td></tr>
                <tr><td><span class="trg-help-eg">name empty</span></td><td>true if variable is empty or unset</td></tr>
            </table>
            <p style="margin-top:4px;margin-bottom:2px"><strong>Numeric comparisons</strong> — use bare variable names or <span class="trg-help-eg">chatvar::name</span> / <span class="trg-help-eg">globalvar::name</span> (with optional <span class="trg-help-eg">.key</span> or <span class="trg-help-eg">[key]</span>):</p>
            <table class="trg-ref-table" style="margin-bottom:4px">
                <tr><td><span class="trg-help-eg">name &gt; 10</span></td><td><span class="trg-help-eg">name &lt; 10</span></td><td><span class="trg-help-eg">name &gt;= 10</span></td><td><span class="trg-help-eg">name &lt;= 10</span></td></tr>
            </table>
            <table class="trg-ref-table" style="margin-bottom:6px">
                <tr><td><span class="trg-help-eg">{{if chatvar::hp &lt; 20}}Critical!{{/if}}</span></td></tr>
                <tr><td><span class="trg-help-eg">{{if chatvar::stats.gold &gt;= 100}}Can afford it.{{/if}}</span></td></tr>
                <tr><td><span class="trg-help-eg">{{if chatvar::hp &lt;= 0 OR chatvar::hp &gt; 100}}Out of range.{{/if}}</span></td></tr>
            </table>
            <p style="margin-top:4px">Boolean — precedence: <span class="trg-help-eg">!</span> &gt; <span class="trg-help-eg">AND</span> &gt; <span class="trg-help-eg">OR</span> &gt; <span class="trg-help-eg">( )</span></p>
            <table class="trg-ref-table trg-ref-examples" style="margin-top:4px">
                <tr><td><span class="trg-help-eg">{{if keyword matches "breath|hitch"}}Forced Physical Reaction Cliché{{/if}}</span></td></tr>
                <tr><td><span class="trg-help-eg">{{if keyword matches "breath" AND message contains "shaky"}}label{{/if}}</span></td></tr>
                <tr><td><span class="trg-help-eg">{{if keyword matches "breath" OR keyword matches "claiming"}}label{{/if}}</span></td></tr>
                <tr><td><span class="trg-help-eg">{{if !(keyword empty)}}Matched: {{keyword}}{{/if}}</span></td></tr>
            </table>
        </div>
        </div>

        <div class="inline-drawer trg-ref-subdrawer">
        <div class="inline-drawer-toggle inline-drawer-header trg-ref-sub-hdr">
            ST variables <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content trg-ref-sub-content">
            <p>ST variables persist beyond the current turn. Use them for counters, flags, and state that should survive across generations.</p>
            <table class="trg-ref-table">
                <tr><td><span class="trg-help-eg">{{chatvar::name}}</span></td><td>read ST chat variable — persists within this chat</td></tr>
                <tr><td><span class="trg-help-eg">{{globalvar::name}}</span></td><td>read ST global variable — persists across all chats</td></tr>
                <tr><td><span class="trg-help-eg">{{chatvar::stats.hp}}</span></td><td>read object property <span class="trg-help-eg">hp</span> from variable <span class="trg-help-eg">stats</span></td></tr>
                <tr><td><span class="trg-help-eg">{{chatvar::inventory[0]}}</span></td><td>read array index 0 from variable <span class="trg-help-eg">inventory</span></td></tr>
            </table>
            <p style="margin-top:6px">Both <span class="trg-help-eg">.key</span> and <span class="trg-help-eg">[key]</span> syntax work — they are equivalent. One level of indexing supported.</p>
            <p style="margin-top:6px">Write with the <strong>Set ST variable</strong> action. The optional <em>key</em> field writes to a property or array index, building an object or array automatically if the variable is unset.</p>
            <table class="trg-ref-table" style="margin-top:4px">
                <tr><td><em>name</em> = <span class="trg-help-eg">stats</span>, <em>key</em> = <span class="trg-help-eg">hp</span>, <em>value</em> = <span class="trg-help-eg">{{math: {{chatvar::stats.hp}} - 15 }}</span></td></tr>
            </table>
            <p style="opacity:.6;font-size:.9em;margin-top:6px">ST variables are also accessible from SillyTavern's own slash commands (<span class="trg-help-eg">/setvar</span>, <span class="trg-help-eg">/getvar</span>, <span class="trg-help-eg">/incvar</span>) and Quick Replies. Triggeryze turn variables (set via <em>Save as</em>) are separate — they clear every generation.</p>
        </div>
        </div>

    </div>
    </div>
    </div>
</div>
</div>
</div>`);

    const s    = getSettings();
    const save = () => { saveSettingsDebounced(); updateProfileDirtyIndicator(); };

    $('#trg_enabled').prop('checked', s.enabled);
    $('#trg_verbose').prop('checked', s.verbose);
    $('#trg_nonstreaming').prop('checked', s.nonStreaming);
    $('#trg_showbadges').prop('checked', s.showBadges);

    $('#trg_enabled').on('change', function () { getSettings().enabled = this.checked; saveSettingsDebounced(); });
    $('#trg_verbose').on('change', function () { getSettings().verbose = this.checked; saveSettingsDebounced(); });
    $('#trg_nonstreaming').on('change', function () { getSettings().nonStreaming = this.checked; saveSettingsDebounced(); });
    $('#trg_showbadges').on('change', function () {
        getSettings().showBadges = this.checked;
        saveSettingsDebounced();
        if (this.checked) reinjectAllBadges(); else removeAllBadges();
    });
    $('#trg_add_ruleset').on('click', () => {
        const newRs = { id: makeId(), name: '', enabled: true, rules: [] };
        getSettings().rulesets.push(newRs);
        expandOnCreate('ruleset', newRs.id);
        save();
        renderRules(save);
    });

    refreshProfileDropdown();
    bindProfileHandlers(() => renderRules(save));
    renderRules(save);
}
