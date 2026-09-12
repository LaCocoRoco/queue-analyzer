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

---Returns the display name of the Mythic Keystone dungeon for your own
---current Group Finder listing (used by the webapp's Season/Dungeon toggle
---to look up dungeon-specific WarcraftLogs data instead of whole-season
---data), or nil if you have no active listing or it isn't a Keystone
---activity. Strips the trailing "(Mythic Keystone)"-style parenthetical
---Blizzard appends to the activity name, to match WarcraftLogs' own plain
---dungeon names as closely as possible.
---@return string|nil
local function GetCurrentDungeonName()
	local entry = C_LFGList.GetActiveEntryInfo()
	if not entry or not entry.activityID then
		return nil
	end
	local activityInfo = C_LFGList.GetActivityInfo(entry.activityID)
	if not activityInfo or not activityInfo.fullName then
		return nil
	end
	local name = activityInfo.fullName:gsub("%s*%b()%s*$", "")
	return name ~= "" and name or nil
end

---Collect "Name-Realm", Blizzard's own Mythic+ rating and item level for
---every member of every current applicant, as flat triplets (Name-Realm,
---rating, item level, repeating) -- C_LFGList.GetApplicantMemberInfo already
---returns dungeonScore (Blizzard's own in-game Mythic+ rating, the same
---number shown in the "Rating" column) and itemLevel in the very same call
---we use for the name, at zero extra cost -- no separate request, no
---network round trip. dungeonScore is a DIFFERENT number from raider.io's
---own score (two independently calculated ratings that happen to correlate
---closely, not the same value) -- the webapp uses it as a fast default and
---only calls raider.io itself if you explicitly ask it to.
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
				local fullName, _, _, _, itemLevel, _, _, _, _, _, _, dungeonScore =
					C_LFGList.GetApplicantMemberInfo(applicantID, memberIdx)
				if fullName then
					local name, realm = strsplit("-", fullName)
					if not realm or realm == "" then
						realm = GetNormalizedRealmName()
					end
					table.insert(entries, name .. "-" .. realm)
					table.insert(entries, tostring(math.floor((dungeonScore or 0) + 0.5)))
					table.insert(entries, tostring(math.floor((itemLevel or 0) + 0.5)))
				end
			end
		end
	end

	return entries
end

-- Data imported from the webapp (pasted into the import window below), keyed
-- by the same "Name-Realm" string GetApplicantNames() produces, valued by a
-- {best, rank} table -- rank is 0 when the webapp's Filter wasn't active for
-- that export (nothing to show). Session-only (no SavedVariables) --
-- re-paste after each /reload, matching the export side which is also
-- always re-read live.
QueueAnalyzerImportedData = {}

-- Which of the two in-game display styles is active -- set from the leading
-- mode token in the webapp's import string (see ParseImportText), driven by
-- the webapp's Table/Name toggle. "table" shows the readouts anchored next
-- to the role icon/iLvl/Rating columns (HookApplicantReadouts); "name"
-- prefixes the applicant's Name itself (HookApplicantNamePrefix) -- always
-- exactly one of the two, never both. Defaults to "table" until the first
-- import of a session.
QueueAnalyzerDisplayMode = "table"

---Parse the webapp's flat ":"-delimited import string into a lookup table
---plus the requested display mode (see LookupForm.tsx's toExportString).
---An optional leading "TABLE" or "NAME" token selects the mode; everything
---after it is the usual "Name-Realm:Best:Rank" triplets. Safe to split the
---whole string on ":" since names/realms never contain one; rank is 0, not
---omitted, when the webapp had no rank for an entry, so the triplet stride
---never has to guess.
---@param text string
---@return table<string, {best: number, rank: number}>, string
local function ParseImportText(text)
	local data = {}
	local clean = text:gsub("%s", "") -- strip any incidental whitespace/newlines from pasting
	local tokens = {}
	for token in clean:gmatch("[^:]+") do
		table.insert(tokens, token)
	end

	local mode = "table"
	local startIdx = 1
	if tokens[1] == "TABLE" or tokens[1] == "NAME" then
		mode = tokens[1]:lower()
		startIdx = 2
	end

	for i = startIdx, #tokens - 2, 3 do
		local key = tokens[i]
		local best = tonumber(tokens[i + 1])
		local rank = tonumber(tokens[i + 2])
		if key and best and rank then
			data[key] = { best = best, rank = rank }
		end
	end
	return data, mode
end

-- Percentile color tiers, matching the webapp's percentileColor() exactly
-- (same hex values: orange/purple/blue/green/grey).
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

---@return {best: number, rank: number}|nil
local function GetImportedData(name, realm)
	return QueueAnalyzerImportedData[name .. "-" .. realm]
end

-- Blizzard only repaints an applicant row (which is what actually runs our
-- HookApplicantReadouts/HookApplicantNamePrefix hooks) when its own
-- scrolling/recycling code reinitializes that row -- importing new data
-- here doesn't trigger that, which is why the freshly imported best/rank
-- previously only showed up after scrolling the list up/down (confirmed:
-- that's the same underlying mechanism, just Blizzard-triggered instead of
-- us triggering it). There's no stable public "just redraw everything" API
-- for this list (and it's changed across expansions), so instead of
-- guessing at one, this walks every descendant frame of the applicant
-- panel looking for member sub-frames -- identified by .memberIdx, which
-- Blizzard sets directly on them (same field HookApplicantTooltip already
-- reads) -- and re-invokes the exact same per-member update function
-- Blizzard itself calls to paint a row. Guaranteed correct since it's the
-- very code path our own hooks already piggyback on; just called by us,
-- right after an import, instead of waiting for a scroll to trigger it.
local function RefreshApplicantListDisplay()
	local panel = LFGListFrame and LFGListFrame.ApplicationViewer
	if not panel or not LFGListApplicationViewer_UpdateApplicantMember then
		return
	end

	local function Walk(f, applicantID)
		for _, child in ipairs({ f:GetChildren() }) do
			local childApplicantID = child.applicantID or applicantID
			if child.memberIdx and childApplicantID then
				LFGListApplicationViewer_UpdateApplicantMember(child, childApplicantID, child.memberIdx)
			end
			Walk(child, childApplicantID)
		end
	end
	Walk(panel, nil)
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
		local data, mode = ParseImportText(f.importBox:GetText())
		local count = 0
		for _ in pairs(data) do
			count = count + 1
		end
		QueueAnalyzerImportedData = data
		QueueAnalyzerDisplayMode = mode
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
	local dungeonName = GetCurrentDungeonName() or ""

	-- One flat ":"-delimited string ("DungeonName:Name-Realm:Rating:ItemLevel:...")
	-- instead of separate lines -- easier to select/copy reliably as a
	-- single line, and the webapp reads it back the same way (splits on
	-- ":"; names/realms/dungeon names never contain ":"). The dungeon name
	-- is always the first field when there's anything at all to export,
	-- even if it's itself empty (no active Keystone listing) -- the
	-- webapp's Season/Dungeon toggle needs a fixed position to read it
	-- from, and an empty leading field (just ":Name-Realm:...") parses fine
	-- on that side (see lib/lookup.ts's parseClipboardText, which splits on
	-- the FIRST colon rather than filtering blanks like the rest of the
	-- string). But truly empty (no dungeon AND no applicants) stays a
	-- genuinely empty string, not a stray lone ":" -- that showed up in the
	-- Export field on every addon startup before any listing existed.
	local text = ""
	if dungeonName ~= "" or #entries > 0 then
		text = dungeonName .. ":" .. table.concat(entries, ":")
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
			-- Whole numbers only -- the webapp now exports Best rounded, no
			-- decimals, so "%d" (not "%.1f") avoids a stray ".0" suffix.
			GameTooltip:AddLine("Queue Analyzer Best: " .. PercentileColorCode(data.best) .. string.format("%d", data.best) .. "|r")
			GameTooltip:Show()
		end
	end)
end

-- Prepends "RANK:BEST:" (or just "BEST:" when no rank was exported) to the
-- name shown for each applicant member in the Application Viewer list
-- itself -- unlike the tooltip above, this is visible without hovering.
-- LFGListApplicationViewer_UpdateApplicantMember is what Blizzard's own code
-- calls to (re)paint a member row's Name text every time the list refreshes
-- (scrolling, new applicants, etc.), so this re-fires often -- it rebuilds
-- the display name itself (Ambiguate + the "  " indent Blizzard uses for
-- group members past the first) from scratch every time rather than reading
-- back member.Name's current text, which would already contain our own
-- prefix from the previous call and double up indefinitely otherwise.
local hookedApplicantNamePrefix = false
local function HookApplicantNamePrefix()
	if hookedApplicantNamePrefix or not LFGListApplicationViewer_UpdateApplicantMember then
		return
	end
	hookedApplicantNamePrefix = true

	hooksecurefunc("LFGListApplicationViewer_UpdateApplicantMember", function(member, appID, memberIdx)
		if QueueAnalyzerDisplayMode ~= "name" then
			return -- "table" mode owns the readouts instead; leave Blizzard's own name untouched
		end

		local fullName = C_LFGList.GetApplicantMemberInfo(appID, memberIdx)
		if not fullName then
			return
		end
		local name, realm = strsplit("-", fullName)
		if not realm or realm == "" then
			realm = GetNormalizedRealmName()
		end

		local data = GetImportedData(name, realm)
		if not data then
			return
		end

		local displayName = Ambiguate(fullName, "short")
		if memberIdx > 1 then
			displayName = "  " .. displayName
		end

		local prefix
		if data.rank > 0 then
			prefix = string.format("%02d:%d:", data.rank, data.best)
		else
			prefix = string.format("%d:", data.best)
		end

		member.Name:SetText(PercentileColorCode(data.best) .. prefix .. "|r" .. displayName)
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

-- "Table" mode: two small readouts anchored next to the iLvl and Rating
-- columns -- the alternative to the name-prefix approach above
-- (HookApplicantNamePrefix), never both at once (see QueueAnalyzerDisplayMode,
-- set from the webapp's Table/Name toggle). Deliberately no header label
-- and the smallest available font: LFGListFrame can't be resized (both
-- corners are anchored, so SetWidth is a no-op -- confirmed live), so this
-- has zero room to spare.
--   1. After iLvl: rank, anchored to member.ItemLevel.
--   2. After Rating: log, anchored to member.Rating the same way. No longer
--      anything next to the role icon -- that spot was too cramped once
--      applicants show 2-3 role icons, and iLvl/Rating already cover
--      rank+log between them.
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

		-- "name" mode owns the display instead -- clear our own readouts
		-- (in case a previous import left "table" text sitting there from
		-- earlier this session) rather than leaving stale numbers up.
		local data = QueueAnalyzerDisplayMode == "table" and GetImportedData(name, realm) or nil

		if not member.QueueAnalyzerIlvlReadout then
			member.QueueAnalyzerIlvlReadout = member:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
		end
		if not member.QueueAnalyzerRatingReadout then
			member.QueueAnalyzerRatingReadout = member:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
		end

		if not data then
			member.QueueAnalyzerIlvlReadout:SetText("")
			member.QueueAnalyzerRatingReadout:SetText("")
			return
		end

		member.QueueAnalyzerIlvlReadout:ClearAllPoints()
		member.QueueAnalyzerIlvlReadout:SetPoint("LEFT", member.ItemLevel, "RIGHT", 2, 0)
		local rankText = data.rank > 0 and string.format("%02d", data.rank) or ""
		member.QueueAnalyzerIlvlReadout:SetText(PercentileColorCode(data.best) .. rankText .. "|r")

		member.QueueAnalyzerRatingReadout:ClearAllPoints()
		member.QueueAnalyzerRatingReadout:SetPoint("LEFT", member.Rating, "RIGHT", 2, 0)
		member.QueueAnalyzerRatingReadout:SetText(PercentileColorCode(data.best) .. data.best .. "|r")
	end)
end

local function OnGroupFinderLoaded()
	AddApplicationViewerButton()
	HookApplicantTooltip()
	HookApplicantNamePrefix()
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
