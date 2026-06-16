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
import { renderRules }                                                      from './rule-cards.js';

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
        <span>Show status badges on messages</span>
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
        <b>Template Language</b>
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
                <tr><td><span class="trg-var-chip trg-var-chip-ps" style="pointer-events:none">{{psContent...}}</span></td><td>prompt-slot query tokens (postMessage only)</td></tr>
                <tr><td><span class="trg-var-chip trg-var-chip-rule" style="pointer-events:none">{{myVar}}</span></td><td>variable from a prior action in <em>this</em> rule</td></tr>
                <tr><td><span class="trg-var-chip trg-var-chip-global" style="pointer-events:none">{{theirVar}}</span></td><td>variable written by a different rule this turn</td></tr>
            </table>
            <p style="margin-top:6px;margin-bottom:2px;font-weight:bold;opacity:.7">System variables</p>
            <table class="trg-ref-table">
                <tr><td><span class="trg-help-eg">{{keyword}}</span></td><td>word or phrase that matched the trigger</td></tr>
                <tr><td><span class="trg-help-eg">{{up-to}}</span></td><td>all text before the keyword</td></tr>
                <tr><td><span class="trg-help-eg">{{paragraph}}</span></td><td>paragraph containing the keyword</td></tr>
                <tr><td><span class="trg-help-eg">{{message}}</span></td><td>full message text</td></tr>
                <tr><td><span class="trg-help-eg">{{history:[2]}}</span></td><td>last 2 turns of chat history — literal N in brackets, or bare turn variable name</td></tr>
                <tr><td><span class="trg-help-eg">{{char}}</span></td><td>character name</td></tr>
                <tr><td><span class="trg-help-eg">{{user}}</span></td><td>user name</td></tr>
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
            </table>
            <p style="opacity:.6;font-size:.9em">Operators: <span class="trg-help-eg">+ - * / % **</span> and parentheses. Returns empty string on invalid input.</p>
        </div>
        </div>

        <div class="inline-drawer trg-ref-subdrawer">
        <div class="inline-drawer-toggle inline-drawer-header trg-ref-sub-hdr">
            Lorebook queries <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content trg-ref-sub-content">
            <p>All four positions are optional — trailing colons can be omitted. Empty position = wildcard (match all).</p>
            <div class="trg-help-eg trg-ref-block">{{lbContent:[lbname]:[titlename]:[keyname]:[mode]}}</div>
            <table class="trg-ref-table">
                <tr><td><span class="trg-help-eg">lbname</span></td><td>lorebook name to search in &nbsp;<em style="opacity:.5">(default: all lorebooks)</em></td></tr>
                <tr><td><span class="trg-help-eg">titlename</span></td><td>entry title to match &nbsp;<em style="opacity:.5">(default: any title)</em></td></tr>
                <tr><td><span class="trg-help-eg">keyname</span></td><td>activation key to match &nbsp;<em style="opacity:.5">(default: any key)</em></td></tr>
                <tr><td><span class="trg-help-eg">mode</span></td><td><span class="trg-help-eg">first</span> | <span class="trg-help-eg">last</span> | <span class="trg-help-eg">all</span></td></tr>
            </table>
            <p><strong>Filter values:</strong> <span class="trg-help-eg">[Literal]</span> = exact literal &nbsp;·&nbsp; <span class="trg-help-eg">[A,B,C]</span> = match any of these &nbsp;·&nbsp; bare word = turn variable name resolved at runtime</p>
            <table class="trg-ref-table">
                <tr><td><span class="trg-help-eg">{{lbContent:...}}</span></td><td>entry content &nbsp;<em style="opacity:.5">mode default: first</em></td></tr>
                <tr><td><span class="trg-help-eg">{{lbTitles:...}}</span></td><td>comma-separated entry titles &nbsp;<em style="opacity:.5">mode default: all</em></td></tr>
                <tr><td><span class="trg-help-eg">{{lbKeys:...}}</span></td><td>comma-separated activation keys &nbsp;<em style="opacity:.5">mode default: all</em></td></tr>
                <tr><td><span class="trg-help-eg">{{lbBooks:...}}</span></td><td>comma-separated lorebook names containing matching entries &nbsp;<em style="opacity:.5">mode default: all</em></td></tr>
            </table>
            <table class="trg-ref-table" style="margin-top:6px">
                <tr><td><span class="trg-help-eg">{{lbContent::[Elara]}}</span></td><td>content of entry titled "Elara" (lb=any, key=any)</td></tr>
                <tr><td><span class="trg-help-eg">{{lbContent:::[love]}}</span></td><td>content of entry with activation key "love" (lb=any, title=any)</td></tr>
                <tr><td><span class="trg-help-eg">{{lbContent:[MyLB]::[love]}}</span></td><td>entry with key "love" in lorebook "MyLB"</td></tr>
                <tr><td><span class="trg-help-eg">{{lbContent::nameVar}}</span></td><td>entry titled by turn variable <span class="trg-help-eg">nameVar</span></td></tr>
                <tr><td><span class="trg-help-eg">{{lbTitles}}</span></td><td>all active entry titles</td></tr>
                <tr><td><span class="trg-help-eg">{{lbBooks}}</span></td><td>names of all active lorebooks</td></tr>
                <tr><td><span class="trg-help-eg">{{lbBooks:::[love]}}</span></td><td>which lorebooks have an entry with key "love"</td></tr>
                <tr><td><span class="trg-help-eg">{{lbContent::::all}}</span></td><td>all entry contents joined with blank lines</td></tr>
            </table>
            <p style="opacity:.6;font-size:.9em">Keyword fields also support lb tokens and <span class="trg-help-eg">{{varName}}</span> expansion.</p>
        </div>
        </div>

        <div class="inline-drawer trg-ref-subdrawer">
        <div class="inline-drawer-toggle inline-drawer-header trg-ref-sub-hdr">
            Prompt-slot queries <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content trg-ref-sub-content">
            <p>Surface the exact context stack sent to the LLM for the last generation. Resolves at <strong>postMessage</strong> stage only — produces no output during streaming.</p>
            <div class="trg-help-eg trg-ref-block">{{psName:[nameFilter]:[mode]}}<br>{{psContent:[nameFilter]:[mode]}}</div>
            <table class="trg-ref-table">
                <tr><td><span class="trg-help-eg">nameFilter</span></td><td>which slots to include &nbsp;<em style="opacity:.5">(default: all)</em></td></tr>
                <tr><td><span class="trg-help-eg">mode</span></td><td><span class="trg-help-eg">first</span> | <span class="trg-help-eg">last</span> | <span class="trg-help-eg">all</span></td></tr>
            </table>
            <p><strong>Filter forms:</strong> <span class="trg-help-eg">[worldInfoBefore]</span> exact identifier or display name &nbsp;·&nbsp; <span class="trg-help-eg">[world*]</span> glob &nbsp;·&nbsp; bare word = turn variable whose value is used as the filter</p>
            <p><strong>Mode defaults:</strong> <span class="trg-help-eg">psName</span> defaults to <span class="trg-help-eg">all</span> (newline-separated names) &nbsp;·&nbsp; <span class="trg-help-eg">psContent</span> defaults to <span class="trg-help-eg">first</span></p>
            <table class="trg-ref-table" style="margin-top:6px">
                <tr><td><span class="trg-help-eg">{{psName}}</span></td><td>all slot names, one per line</td></tr>
                <tr><td><span class="trg-help-eg">{{psContent}}</span></td><td>content of the first slot</td></tr>
                <tr><td><span class="trg-help-eg">{{psContent:[worldInfoBefore]}}</span></td><td>World Info Before content</td></tr>
                <tr><td><span class="trg-help-eg">{{psContent:[cnz_rag]}}</span></td><td>CNZ RAG slot content by identifier</td></tr>
                <tr><td><span class="trg-help-eg">{{psName:[world*]}}</span></td><td>names of all worldInfo* slots</td></tr>
                <tr><td><span class="trg-help-eg">{{psContent:[world*]:all}}</span></td><td>all worldInfo slot contents joined with blank lines</td></tr>
                <tr><td><span class="trg-help-eg">{{psContent::all}}</span></td><td>full context stack, every slot joined with blank lines</td></tr>
                <tr><td><span class="trg-help-eg">{{psContent:mySlot}}</span></td><td>slot whose name is stored in turn variable <span class="trg-help-eg">mySlot</span></td></tr>
            </table>
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
        getSettings().rulesets.push({ id: makeId(), name: '', enabled: true, rules: [] });
        save();
        renderRules(save);
    });

    refreshProfileDropdown();
    bindProfileHandlers(() => renderRules(save));
    renderRules(save);
}
