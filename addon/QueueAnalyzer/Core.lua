-- Core.lua
-- Reads every current applicant to your posted Group Finder listing (you
-- must be the group leader with an active listing that has applicants --
-- this is the Premade Groups applicant queue, not the anonymous automatic
-- Dungeon Finder matchmaking queue, which never exposes names at all).
--
-- C_LFGList.GetApplicants() returns every applicant ID for your listing in
-- one call (confirmed against Blizzard's own LFGListApplicationViewer
-- update code) -- no need to hover or scroll through the UI. The raw order
-- it comes back in does NOT match the on-screen applicant list order
-- (confirmed live) -- Blizzard itself re-sorts it before display via
-- LFGListUtil_SortApplicants (new applications to the bottom, otherwise by
-- applicantInfo.displayOrderID), so we call that exact same function on our
-- own copy before reading names, to match what you see in the window.

BINDING_HEADER_QUEUEANALYZER = "Queue Analyzer"
BINDING_NAME_QUEUEANALYZER_TOGGLE = "Show/export applicant names"

-- Read once from our own .toc's "## Version:" line -- the single source of
-- truth for the addon's version, used both in the Export marker (so the
-- webapp can tell whether it's talking to the addon version it expects)
-- and to validate the Import marker the webapp sends back (see
-- ParseImportText) -- the webapp hardcodes this same version string as
-- what it currently targets, so a mismatch in either direction means one
-- side is stale.
local ADDON_VERSION = C_AddOns.GetAddOnMetadata("QueueAnalyzer", "Version") or "0.0.0"

-- Only the MAJOR component of a "MAJOR.MINOR.PATCH" version string matters
-- for addon<->webapp compatibility (see ParseImportText/QueueAnalyzer_RefreshExport)
-- -- Minor/patch bumps are assumed backwards compatible, only a MAJOR
-- change means the two sides actually disagree on the data format.
local function MajorVersion(version)
	return version:match("^(%d+)") or version
end

StaticPopupDialogs["QUEUEANALYZER_WRONG_VERSION"] = {
	text = "Falsche Version. Bitte Addon aktualisieren.",
	button1 = OKAY,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
}

---Returns info about your own current Group Finder listing (used by the
---webapp to decide whether to query WarcraftLogs' Mythic+ season data or a
---specific raid zone/difficulty, instead of whole-season-only data), or nil
---if you have no active listing or it's neither a Mythic+ Keystone nor a
---raid activity (e.g. PvP, Quests -- WCL Log data doesn't apply). Strips the
---trailing "(Mythic Keystone)"/"(Heroic)"-style parenthetical Blizzard
---appends to the activity name, to match WarcraftLogs' own plain zone names
---as closely as possible -- the difficulty itself comes from
---activityInfo's own boolean flags below instead, not by parsing that
---parenthetical.
---
---C_LFGList.GetActiveEntryInfo() returns `activityIDs` (plural, an array --
---confirmed against current API docs; the field used to be singular
---`activityID` before patch 10.2.7/11.0.7, which is what this originally,
---incorrectly, checked for and always got nil). GetActivityInfo() (singular
---info, no "Table" suffix) is also deprecated and returns positional
---values, not a table -- GetActivityInfoTable() is the current table-based
---replacement and is what actually has a `.fullName` field.
---
---isNormalActivity/isHeroicActivity/isMythicActivity/isMythicPlusActivity
---(confirmed against Blizzard's own LFGList.lua and the current API docs)
---are exactly the fields Blizzard's own difficulty filter UI reads --
---reliable, no need to parse the difficulty out of the activity name
---ourselves. LFR is deliberately not handled -- Raid Finder groups aren't
---organized through the Premade Groups applicant system this addon reads
---from in the first place.
---@return {type: "M"|"R", difficulty: string, name: string}|nil
local function GetCurrentInstanceInfo()
	local entry = C_LFGList.GetActiveEntryInfo()
	if not entry or not entry.activityIDs or not entry.activityIDs[1] then
		return nil
	end
	local activityInfo = C_LFGList.GetActivityInfoTable(entry.activityIDs[1])
	if not activityInfo or not activityInfo.fullName then
		return nil
	end
	local name = activityInfo.fullName:gsub("%s*%b()%s*$", "")
	if name == "" then
		return nil
	end

	if activityInfo.isMythicPlusActivity then
		return { type = "M", difficulty = "-", name = name }
	elseif activityInfo.isMythicActivity then
		return { type = "R", difficulty = "M", name = name }
	elseif activityInfo.isHeroicActivity then
		return { type = "R", difficulty = "H", name = name }
	elseif activityInfo.isNormalActivity then
		return { type = "R", difficulty = "N", name = name }
	end
	return nil
end

---Collect Name, Server, Blizzard's own item level, Mythic+ rating, assigned
---role and spec ID for every member of every current applicant, as flat
---sextuplets (Name, Server, Role, ItemLevel, Rating, SpecID, repeating) --
---C_LFGList.GetApplicantMemberInfo already returns itemLevel, dungeonScore
---(Blizzard's own in-game Mythic+ rating, the same number shown in the
---"Rating" column), assignedRole AND specID in the very same call we use for
---the name, at zero extra cost -- no separate request, no network round
---trip. assignedRole (not the tank/healer/damage boolean flags, which can
---all be true at once for a flexible/multi-role application) is Blizzard's
---OWN resolution of "which single role is this specific application
---actually for" -- exactly the thing we'd otherwise have to guess at from a
---cached, possibly-stale WCL spec lookup. specID is that same live-and-free
---advantage applied to the webapp's RaiderIO Tier grade (lib/rioTier.ts) --
---it used to come from a separate WCL gameData call that's either slow
---(forceUpdate: true) or sometimes just empty (WCL never independently
---cached it for that character) -- this is instant and always accurate to
---what the applicant is CURRENTLY playing. Name and Server are kept as
---separate fields (rather than one hyphenated "Name-Realm" string) so the
---webapp never has to guess a split point on a realm name. dungeonScore is a
---DIFFERENT number from raider.io's own score (two independently calculated
---ratings that happen to correlate closely, not the same value) -- the
---webapp uses it as a fast default and only calls raider.io itself if you
---explicitly ask it to.

---Shortens Blizzard's assignedRole ("TANK"/"HEALER"/"DAMAGER"/"NONE"/"") to
---a single letter for the export string -- one more field tacked onto every
---single applicant member adds up fast in a one-line EditBox. Matches the
---webapp's parseAssignedRole exactly (lib/lookup.ts); anything unrecognized
---(including "NONE"/"") becomes "", same as before.
---@param assignedRole string|nil
---@return string
local function AssignedRoleCode(assignedRole)
	if assignedRole == "TANK" then
		return "T"
	elseif assignedRole == "HEALER" then
		return "H"
	elseif assignedRole == "DAMAGER" then
		return "D"
	else
		return ""
	end
end

---@return string[] entries
local function GetApplicantNames()
	local entries = {}

	local applicants = C_LFGList.GetApplicants()
	if LFGListUtil_SortApplicants then
		LFGListUtil_SortApplicants(applicants)
	end
	for _, applicantID in ipairs(applicants) do
		local info = C_LFGList.GetApplicantInfo(applicantID)
		if info then
			for memberIdx = 1, info.numMembers do
				local fullName, _, _, _, itemLevel, _, _, _, _, assignedRole, _, dungeonScore, _, _, _, specID =
					C_LFGList.GetApplicantMemberInfo(applicantID, memberIdx)
				if fullName then
					local name, realm = strsplit("-", fullName)
					if not realm or realm == "" then
						realm = GetNormalizedRealmName()
					end
					table.insert(entries, name)
					table.insert(entries, realm)
					table.insert(entries, AssignedRoleCode(assignedRole))
					table.insert(entries, tostring(math.floor((itemLevel or 0) + 0.5)))
					table.insert(entries, tostring(math.floor((dungeonScore or 0) + 0.5)))
					table.insert(entries, tostring(specID or 0))
				end
			end
		end
	end

	return entries
end

-- Data imported from the webapp (pasted into the import window below), keyed
-- by the same "Name-Realm" string GetApplicantNames() produces, valued by a
-- {best, rank, tier} table -- rank is 0 when the webapp's Filter wasn't
-- active for that export (nothing to show); tier is nil when the webapp had
-- no RaiderIO spec grade for this character's spec. Session-only (no
-- SavedVariables) -- re-paste after each /reload, matching the export side
-- which is also always re-read live.
QueueAnalyzerImportedData = {}

---Parse the webapp's flat ":"-delimited import string into a lookup table
---(see LookupForm.tsx's toExportString) -- "Name-Realm:Best:Rank:Tier"
---quadruplets. Safe to split the whole string on ":" since names/realms
---never contain one; rank is 0, not omitted, when the webapp had no rank
---for an entry, and tier is "-", never an empty string, when the webapp had
---no grade -- an empty field WOULD break this parser, since gmatch("[^:]+")
---below never yields an empty capture for "::", silently skipping it and
---shifting every field after it by one. The quadruplet stride never has to
---guess as long as the webapp holds up its end of that contract.
---
---Requires the string to END in "i<version>" (see toExportString on the
---webapp side, and ADDON_VERSION's comment) -- this addon's OWN Export
---string ends in "e<version>" instead and is otherwise the same shape
---("Name-Realm:number:number" fields), so without this check, pasting the
---Export field's own content back into Import here used to get silently
---accepted as if it were real ranked results, reading Rating/ItemLevel as
---Best/Rank. Only the MAJOR component of the embedded version has to match
---this addon's own ADDON_VERSION's major -- Minor/patch differences are
---assumed backwards compatible (nothing about the data format itself
---changed), only a MAJOR bump means the webapp build and this addon build
---actually disagree on the format, which silently misreading as valid would
---be worse than refusing outright. Returns nil data and an error message in
---either failure case, rather than guessing.
---@param text string
---@return table<string, {best: number, rank: number, tier: string|nil}>|nil data
---@return string|nil errorMessage
---@return boolean|nil isVersionMismatch
local function ParseImportText(text)
	local clean = text:gsub("%s", "") -- strip any incidental whitespace/newlines from pasting
	local tokens = {}
	for token in clean:gmatch("[^:]+") do
		table.insert(tokens, token)
	end

	local marker = tokens[#tokens]
	local importVersion = marker and marker:match("^i(.+)$")
	if not importVersion then
		return nil, "Not an Import result (paste the webapp's output, not the Export field)."
	end
	if MajorVersion(importVersion) ~= MajorVersion(ADDON_VERSION) then
		return nil, "Wrong version. Please update the addon.", true
	end
	table.remove(tokens) -- drop the trailing marker, not part of the data itself

	local data = {}
	for i = 1, #tokens - 3, 4 do
		local key = tokens[i]
		local best = tonumber(tokens[i + 1])
		local rank = tonumber(tokens[i + 2])
		local tier = tokens[i + 3]
		if key and best and rank then
			data[key] = { best = best, rank = rank, tier = (tier ~= "-" and tier or nil) }
		end
	end
	return data, nil
end

-- Percentile color tiers, matching the webapp's percentileColor() exactly
-- (same hex values: orange/purple/blue/green/grey). Used for the LOG value
-- specifically.
local function PercentileColorCode(pct)
	if pct >= 95 then
		return "|cffff8000" -- orange
	elseif pct >= 75 then
		return "|cffa335ee" -- purple
	elseif pct >= 50 then
		return "|cff0070dd" -- blue
	elseif pct >= 25 then
		return "|cff1eff00" -- green
	else
		return "|cff9d9d9d" -- grey
	end
end

-- Spec-strength Tier grade (S/A/B/C), matching the webapp's TIER_COLOR
-- exactly (lib/rioTier.ts) -- a deliberately DIFFERENT palette from
-- PercentileColorCode above, so a Tier letter is never visually confused
-- with a Log percentile despite both being letter/number "how good"
-- indicators. Returns "" (not colored text) for an unknown/nil tier, safe
-- to concatenate unconditionally.
local function TierColorCode(tier)
	if tier == "S" then
		return "|cffff8000S|r" -- orange
	elseif tier == "A" then
		return "|cffff3333A|r" -- red
	elseif tier == "B" then
		return "|cff0070ddB|r" -- blue
	elseif tier == "C" then
		return "|cff9d9d9dC|r" -- grey
	else
		return ""
	end
end

---@return {best: number, rank: number, tier: string|nil}|nil
local function GetImportedData(name, realm)
	return QueueAnalyzerImportedData[name .. "-" .. realm]
end

-- Blizzard only repaints an applicant row (which is what actually runs our
-- HookApplicantReadouts hook) when its own scrolling/recycling code
-- reinitializes that row -- importing new data here doesn't trigger that,
-- which is why the freshly imported best/rank previously only showed up
-- after scrolling the list up/down.
--
-- The applicant panel (LFGListFrame.ApplicationViewer) uses a virtualized
-- ScrollBox (confirmed against Blizzard's own LFGList.lua source) -- rows
-- currently scrolled out of view have NO frame at all until the ScrollBox
-- creates/reuses one for them, so nothing (not even Blizzard itself) can
-- eagerly repaint an off-screen row without an actual scroll; that part is
-- an inherent limitation, not a bug. What CAN be forced is a repaint of
-- every row that IS currently on screen -- this used to walk every
-- descendant frame of the panel manually looking for .memberIdx sub-frames
-- and re-invoke the per-member update function on each one, which worked
-- but was fragile (any wrong assumption about the exact frame hierarchy
-- could silently stop matching, which is the likely cause of "sometimes
-- doesn't refresh"). LFGListApplicationViewer_UpdateResults is Blizzard's
-- OWN "rebuild the results list" function (re-supplies the ScrollBox's data
-- provider, which forces it to reacquire and repaint every
-- currently-realized row through the exact same per-member update
-- function) -- more robust since it's the same call Blizzard's own code
-- uses, not our own guess at their frame structure.
local function RefreshApplicantListDisplay()
	local panel = LFGListFrame and LFGListFrame.ApplicationViewer
	if not panel or not LFGListApplicationViewer_UpdateResults then
		return
	end
	LFGListApplicationViewer_UpdateResults(panel)
end

local REPO_URL = "https://github.com/LaCocoRoco/queue-analyzer"

-- WoW has no concept of a clickable external link (chat hyperlinks only
-- open in-game item/spell/quest panels, never a browser), so this is just
-- a single-line EditBox pre-filled with the URL -- click it to select-all,
-- then Ctrl+C, same copy pattern as the export/import boxes below. Sits in
-- the title bar itself, right-aligned next to "Analyzer" -- same grey
-- (GameFontDisableSmall) as before, just relocated now that the window no
-- longer has a dedicated footer row. Stops well short of TOPRIGHT to clear
-- BasicFrameTemplateWithInset's built-in close button. Informational only:
-- never fetched or used by the addon itself.
local function AddRepoFooter(f)
	local box = CreateFrame("EditBox", nil, f)
	-- Wide enough for the full URL text at GameFontDisableSmall -- too
	-- narrow (190) clipped it, and since an EditBox's cursor lands at the
	-- END of the text after SetText, a too-narrow box scrolls to show the
	-- TAIL of the string instead of the start, not an ellipsis -- which
	-- looked like "CocoRoco/queue-analyzer" instead of the full github.com/... URL.
	box:SetSize(260, 14)
	box:SetPoint("RIGHT", f.TitleBg, "RIGHT", -20, 0)
	box:SetFontObject(GameFontDisableSmall)
	box:SetJustifyH("RIGHT")
	box:SetAutoFocus(false)
	box:SetText(REPO_URL)
	box:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	box:SetScript("OnMouseDown", function(self)
		self:SetFocus()
		self:HighlightText()
	end)
end

local frame

-- One small window instead of two: an Export field (pre-filled, refreshed
-- live from the current applicants) and an Import field (paste the
-- webapp's result back in), both single-line -- the data itself is always
-- one flat ":"-delimited line anyway (see GetApplicantNames/ParseImportText),
-- so a big multi-line scrollable box was never actually needed and only
-- made it fiddly to know where to click to select everything.
local function CreateQueueAnalyzerFrame()
	local f = CreateFrame("Frame", "QueueAnalyzerFrame", UIParent, "BasicFrameTemplateWithInset")
	-- Shorter than the original -- the repo-link footer row moved into the
	-- title bar itself (see AddRepoFooter), so there's no more dedicated
	-- footer space to leave room for below the status line.
	f:SetSize(380, 120)
	-- Docked to the right of the Group Finder window, bottom edges aligned
	-- (not below it, not vertically centered on it either) -- RaiderIO's
	-- own overlay panel sits to the right near the TOP of LFGListFrame, so
	-- anchoring our (short) window to the BOTTOM of that same right-hand
	-- side clears it instead of overlapping. LFGListFrame might not exist
	-- yet if this is the very first time the addon's own window is opened
	-- (Blizzard_GroupFinder is load-on-demand) -- falls back to
	-- screen-center in that case. Deliberately NOT movable/draggable (no
	-- SetMovable/RegisterForDrag) -- this SetPoint anchor is a live relative
	-- link, so as long as it's never broken by a drag, this window just
	-- rides along automatically whenever LFGListFrame itself moves, instead
	-- of needing its own OnUpdate tracking.
	if LFGListFrame then
		f:SetPoint("BOTTOMLEFT", LFGListFrame, "BOTTOMRIGHT", 8, 0)
	else
		f:SetPoint("CENTER")
	end
	tinsert(UISpecialFrames, "QueueAnalyzerFrame") -- Escape closes it
	-- Raised above RaiderIO's own overlay panel -- both sit in the same
	-- screen area (see the docking comment above) and RaiderIO's panel was
	-- winning the default draw order, partially covering our title bar/
	-- Export row. "HIGH" plus SetToplevel (raises within its own strata on
	-- creation/show) reliably wins over RaiderIO's more standard strata.
	f:SetFrameStrata("HIGH")
	f:SetToplevel(true)

	f.title = f:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	f.title:SetPoint("LEFT", f.TitleBg, "LEFT", 5, 0)
	f.title:SetText("Analyzer")

	local exportLabel = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	exportLabel:SetPoint("TOPLEFT", 16, -34)
	exportLabel:SetWidth(50)
	exportLabel:SetJustifyH("LEFT")
	exportLabel:SetText("Export")

	local exportBox = CreateFrame("EditBox", "QueueAnalyzerExportEditBox", f, "InputBoxTemplate")
	exportBox:SetSize(210, 19)
	exportBox:SetPoint("LEFT", exportLabel, "RIGHT", 4, 0)
	exportBox:SetAutoFocus(false)
	exportBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	-- Clicking back in re-selects everything -- you should never need to
	-- manually drag-select in a field that only ever holds one full value.
	exportBox:SetScript("OnEditFocusGained", function(self) self:HighlightText() end)
	f.exportBox = exportBox

	local refreshButton = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
	refreshButton:SetText("Refresh")
	refreshButton:SetSize(74, 22)
	refreshButton:SetPoint("LEFT", exportBox, "RIGHT", 8, 0)
	refreshButton:SetScript("OnClick", function() QueueAnalyzer_RefreshExport() end)

	local importLabel = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	importLabel:SetPoint("TOPLEFT", exportLabel, "BOTTOMLEFT", 0, -32)
	importLabel:SetWidth(50)
	importLabel:SetJustifyH("LEFT")
	importLabel:SetText("Import")

	local importBox = CreateFrame("EditBox", "QueueAnalyzerImportEditBox", f, "InputBoxTemplate")
	importBox:SetSize(210, 19)
	importBox:SetPoint("LEFT", importLabel, "RIGHT", 4, 0)
	importBox:SetAutoFocus(false)
	importBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	-- Auto-select on focus here too -- otherwise a paste without first
	-- clearing old content would insert at the cursor instead of replacing
	-- it, silently corrupting the data.
	importBox:SetScript("OnEditFocusGained", function(self) self:HighlightText() end)
	f.importBox = importBox

	local importButton = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
	importButton:SetText("Import")
	importButton:SetSize(74, 22)
	importButton:SetPoint("LEFT", importBox, "RIGHT", 8, 0)
	importButton:SetScript("OnClick", function()
		local data, errorMessage, isVersionMismatch = ParseImportText(f.importBox:GetText())
		if errorMessage then
			f.status:SetText(errorMessage)
			if isVersionMismatch then
				StaticPopup_Show("QUEUEANALYZER_WRONG_VERSION")
			end
			return
		end
		local count = 0
		for _ in pairs(data) do
			count = count + 1
		end
		QueueAnalyzerImportedData = data
		RefreshApplicantListDisplay()
		f.status:SetText(count .. " entries imported.")
	end)

	f.status = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	f.status:SetPoint("TOPLEFT", importLabel, "BOTTOMLEFT", 4, -8)
	f.status:SetText("")

	AddRepoFooter(f)

	return f
end

function QueueAnalyzer_RefreshExport()
	if not frame then
		return
	end

	local entries = GetApplicantNames()
	local instanceInfo = GetCurrentInstanceInfo()
	local instanceType = instanceInfo and instanceInfo.type or "M"
	local instanceDifficulty = instanceInfo and instanceInfo.difficulty or "-"
	local instanceName = instanceInfo and instanceInfo.name or ""

	-- One flat ":"-delimited string
	-- ("Name:Server:Role:ItemLevel:Rating:SpecID:Name:Server:Role:ItemLevel:Rating:SpecID:...:Type:Difficulty:InstanceName:e<version>")
	-- instead of separate lines -- easier to select/copy reliably as a
	-- single line, and the webapp reads it back the same way (splits on
	-- ":"; names/realms/zone names never contain ":"). Type/Difficulty/
	-- InstanceName are always the LAST three fields before the marker when
	-- there's anything at all to export, even if empty/"-" (no active
	-- listing, or a Mythic+ listing where Difficulty doesn't apply) -- a
	-- single value for the whole listing, not per applicant, so each only
	-- needs to appear once; the webapp needs a fixed position to read them
	-- from (see lib/lookup.ts's parseClipboardText, which reads the LAST
	-- three tokens before the marker rather than assuming every group of 6
	-- is a member). Type defaults to "M" (not "R") when there's no active
	-- listing at all -- matches the pre-existing "empty dungeon name falls
	-- back to season-only data" behavior, just for Mythic+ specifically
	-- rather than an undefined state. Truly empty (no listing AND no
	-- applicants) stays a genuinely empty string, not a stray marker --
	-- that showed up in the Export field on every addon startup before any
	-- listing existed.
	--
	-- The trailing "e<version>" token (ADDON_VERSION -- see its own comment)
	-- is a self-identifying, self-versioning marker: this string's own
	-- shape ("Name:Server:number:number:...") is close enough to the
	-- webapp's Import string's shape that pasting THIS straight back into
	-- the Import box below used to get silently "parsed" as if it were real
	-- ranked results (confirmed live -- rating/item level got read as
	-- best/rank). ParseImportText now refuses anything that doesn't end in
	-- "i<version>" instead of guessing, AND refuses a version that doesn't
	-- match this addon's own -- the webapp encodes which addon version it
	-- was built against the same way.
	local text = ""
	if instanceName ~= "" or #entries > 0 then
		text = table.concat(entries, ":")
			.. ":" .. instanceType
			.. ":" .. instanceDifficulty
			.. ":" .. instanceName
			.. ":e" .. ADDON_VERSION
	end

	frame.exportBox:SetText(text)
	-- Order matters: SetFocus() must come before HighlightText() -- the
	-- reverse order (as this used to be) leaves the text visually selected
	-- but not reliably in the EditBox's actual input focus, so Ctrl+C does
	-- nothing until the user manually clicks in and re-selects.
	frame.exportBox:SetFocus()
	frame.exportBox:HighlightText()
end

function QueueAnalyzer_ToggleFrame()
	if not frame then
		frame = CreateQueueAnalyzerFrame()
	end

	if frame:IsShown() then
		frame:Hide()
		return
	end

	frame:Show()
	QueueAnalyzer_RefreshExport()
end

SLASH_QUEUEANALYZER1 = "/qa"
SLASH_QUEUEANALYZER2 = "/queueanalyzer"
SlashCmdList["QUEUEANALYZER"] = QueueAnalyzer_ToggleFrame

-- Right-click entry on individual applicants: right-clicking a member row
-- already opens a Blizzard context menu (Whisper/Report), built with the
-- modern Menu API and tagged "MENU_LFG_FRAME_MEMBER_APPLY" (confirmed
-- against Blizzard's own LFGListApplicantMember_OnMouseDown). Menu.ModifyMenu
-- is Blizzard's sanctioned extension point for exactly this -- no click
-- hijacking, no taint risk. Safe to register immediately; it fires
-- whenever that menu is opened, regardless of load order.
if Menu and Menu.ModifyMenu then
	Menu.ModifyMenu("MENU_LFG_FRAME_MEMBER_APPLY", function(owner, rootDescription)
		rootDescription:CreateDivider()
		rootDescription:CreateButton("Copy all applicants (Queue Analyzer)", QueueAnalyzer_ToggleFrame)
	end)
end

-- Walk up from an applicant-member row's frame looking for the ancestor that
-- carries .applicantID -- Blizzard stores it on the applicant entry frame,
-- one or two levels above the individual member sub-frame the OnEnter fires
-- on, and the exact depth isn't worth hardcoding when a short walk covers
-- it regardless.
local function FindApplicantID(f)
	local current = f
	for _ = 1, 5 do
		if not current then
			return nil
		end
		if current.applicantID then
			return current.applicantID
		end
		current = current.GetParent and current:GetParent()
	end
	return nil
end

-- Appends the imported "Best" value (colored like the webapp's percentile
-- tiers) to the tooltip Blizzard already shows when hovering a member of an
-- applicant in the Application Viewer -- so you can see it while reviewing
-- applicants instead of alt-tabbing to compare against the webapp table.
-- LFGListApplicantMember_OnEnter is defined inside Blizzard_GroupFinder,
-- which is load-on-demand -- same reason AddApplicationViewerButton below
-- waits for ADDON_LOADED instead of hooking at file-load time.
local hookedApplicantTooltip = false
local function HookApplicantTooltip()
	if hookedApplicantTooltip or not LFGListApplicantMember_OnEnter then
		return
	end
	hookedApplicantTooltip = true

	hooksecurefunc("LFGListApplicantMember_OnEnter", function(self)
		local applicantID = FindApplicantID(self)
		local memberIdx = self.memberIdx
		if not applicantID or not memberIdx then
			return
		end

		local fullName = C_LFGList.GetApplicantMemberInfo(applicantID, memberIdx)
		if not fullName then
			return
		end
		local name, realm = strsplit("-", fullName)
		if not realm or realm == "" then
			realm = GetNormalizedRealmName()
		end

		local data = GetImportedData(name, realm)
		if data and GameTooltip:IsOwned(self) then
			GameTooltip:AddLine(" ")
			-- Whole numbers only, zero-padded to 2 digits (matching the
			-- in-game readouts and the webapp's own LOG column) -- the
			-- webapp now exports Best rounded, no decimals.
			GameTooltip:AddLine("Queue Analyzer Best: " .. PercentileColorCode(data.best) .. string.format("%02d", data.best) .. "|r")
			GameTooltip:Show()
		end
	end)
end

-- Button above the applicant list. LFGListFrame only exists once the
-- Blizzard_GroupFinder addon has loaded (it's load-on-demand), so this
-- waits for that before creating/parenting the button.
local function AddApplicationViewerButton()
	local panel = LFGListFrame.ApplicationViewer
	if not panel or panel.QueueAnalyzerButton then
		return
	end

	local button = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
	button:SetSize(90, 20)
	button:SetText("Analyzer")
	-- Far enough left of TOPRIGHT to clear the panel's own close button --
	-- at -6 the two hitboxes overlapped, so the close button (drawn on top)
	-- silently ate the first click instead of it reaching this one.
	button:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -34, -4)
	button:SetScript("OnClick", QueueAnalyzer_ToggleFrame)
	panel.QueueAnalyzerButton = button
end

-- Star icon for a top-4 rank, squeezed into the Role column's own leftover
-- space after whichever role icon is actually the rightmost visible one
-- (applicants show 1-3 icons depending on which roles they're flexible
-- for) -- anchored to that icon instead of a fixed x-offset so it adapts
-- automatically instead of assuming a fixed icon count. A texture escape
-- (|T...|t) inside the FontString, not a Unicode "★" character -- WoW's UI
-- font doesn't reliably have that glyph, but any FontString can render an
-- arbitrary texture inline like this regardless of font. Single star, not
-- a repeated-count tier (repeating the texture escape via :rep() didn't
-- render correctly in-game) -- tinted per rank instead, using the escape's
-- own trailing r:g:b vertex-color parameters (confirmed supported: WoW's
-- texture escape syntax is |Tpath:height:width:xofs:yofs:texW:texH:left:
-- right:top:bottom:r:g:b|t -- texW/texH/left/right/top/bottom are just set
-- to span the whole source image here, no actual cropping). Same 4 colors
-- as the webapp's rankColor(), since this replaces the rank NUMBER as the
-- in-game "top applicant" marker -- rank is no longer shown as text at all
-- anywhere in-game (see HookApplicantReadouts below).
local function StarIcon(rank)
	local r, g, b
	if rank == 1 then
		r, g, b = 255, 128, 0 -- orange
	elseif rank == 2 then
		r, g, b = 255, 51, 51 -- red
	elseif rank == 3 then
		r, g, b = 0, 112, 221 -- blue
	elseif rank == 4 then
		r, g, b = 30, 255, 0 -- green
	else
		return ""
	end
	return string.format("|TInterface\\Common\\FavoritesIcon:14:14:0:0:16:16:0:16:0:16:%d:%d:%d|t", r, g, b)
end

local function GetLastRoleIcon(member)
	if member.RoleIcon3:IsShown() then
		return member.RoleIcon3
	end
	if member.RoleIcon2:IsShown() then
		return member.RoleIcon2
	end
	return member.RoleIcon1
end

-- Info spread across three spots on the row instead of clustered in one
-- place ("aufgeteilt", explicitly requested) -- deliberately no header
-- label and the smallest available font for the two readouts: LFGListFrame
-- can't be resized (both corners are anchored, so SetWidth is a no-op --
-- confirmed live), so this has zero room to spare.
--   1. Prefixed onto the applicant's Name itself: a single colored star for
--      the top 4 ranks, none past that -- no rank NUMBER anywhere in-game
--      anymore, the star alone is the "good applicant" marker (StarIcon).
--   2. After the last role icon: the RaiderIO spec Tier grade
--      (TierColorCode), for every applicant with a known spec grade,
--      regardless of rank.
--   3. After Rating: log (PercentileColorCode), anchored to member.Rating.
--      Tanks/healers still get a Log value here now (see lib/lookup.ts) --
--      they just never have a rank (data.rank stays 0), so they never get
--      a Name-prefix star, but they still get a Tier grade and Log readout.
local hookedApplicantReadouts = false
local function HookApplicantReadouts()
	if hookedApplicantReadouts or not LFGListApplicationViewer_UpdateApplicantMember then
		return
	end
	hookedApplicantReadouts = true

	hooksecurefunc("LFGListApplicationViewer_UpdateApplicantMember", function(member, appID, memberIdx)
		local fullName = C_LFGList.GetApplicantMemberInfo(appID, memberIdx)
		if not fullName then
			return
		end
		local name, realm = strsplit("-", fullName)
		if not realm or realm == "" then
			realm = GetNormalizedRealmName()
		end

		local data = GetImportedData(name, realm)

		if not member.QueueAnalyzerTierReadout then
			member.QueueAnalyzerTierReadout = member:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
		end
		if not member.QueueAnalyzerRatingReadout then
			member.QueueAnalyzerRatingReadout = member:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
		end

		if not data then
			member.QueueAnalyzerTierReadout:SetText("")
			member.QueueAnalyzerRatingReadout:SetText("")
			-- Blizzard's own call (earlier in this same update, before this
			-- hooksecurefunc runs) already set member.Name correctly -- leave
			-- it untouched rather than rebuilding it with an empty prefix.
			return
		end

		-- Rebuilt from scratch every time (Ambiguate + the "  " indent
		-- Blizzard uses for group members past the first) rather than
		-- reading back member.Name's current text, which would already
		-- contain our own star from a previous call and double up
		-- indefinitely otherwise.
		local displayName = Ambiguate(fullName, "short")
		if memberIdx > 1 then
			displayName = "  " .. displayName
		end
		member.Name:SetText(StarIcon(data.rank) .. displayName)

		-- Re-anchored every update (not just on creation) since which role
		-- icon is the rightmost visible one can change between applicants.
		member.QueueAnalyzerTierReadout:ClearAllPoints()
		member.QueueAnalyzerTierReadout:SetPoint("LEFT", GetLastRoleIcon(member), "RIGHT", 2, 0)
		member.QueueAnalyzerTierReadout:SetText(TierColorCode(data.tier))

		member.QueueAnalyzerRatingReadout:ClearAllPoints()
		member.QueueAnalyzerRatingReadout:SetPoint("LEFT", member.Rating, "RIGHT", 2, 0)
		member.QueueAnalyzerRatingReadout:SetText(PercentileColorCode(data.best) .. string.format("%02d", data.best) .. "|r")
	end)
end

local function OnGroupFinderLoaded()
	AddApplicationViewerButton()
	HookApplicantTooltip()
	HookApplicantReadouts()
end

local loader = CreateFrame("Frame")
loader:RegisterEvent("ADDON_LOADED")
loader:SetScript("OnEvent", function(_, _, addonName)
	if addonName == "Blizzard_GroupFinder" then
		OnGroupFinderLoaded()
	end
end)

-- Blizzard_GroupFinder may already be loaded by the time we get here
-- (e.g. after a /reload while the group finder was open).
if C_AddOns and C_AddOns.IsAddOnLoaded and C_AddOns.IsAddOnLoaded("Blizzard_GroupFinder") then
	OnGroupFinderLoaded()
end
