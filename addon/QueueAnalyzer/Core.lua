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
BINDING_NAME_QUEUEANALYZER_TOGGLE = "Bewerber-Namen anzeigen/exportieren"

---Collect "Name-Realm" for every member of every current applicant.
---@return string[] names
local function GetApplicantNames()
	local names = {}

	local applicants = C_LFGList.GetApplicants()
	if LFGListUtil_SortApplicants then
		LFGListUtil_SortApplicants(applicants)
	end
	for _, applicantID in ipairs(applicants) do
		local info = C_LFGList.GetApplicantInfo(applicantID)
		if info then
			for memberIdx = 1, info.numMembers do
				local fullName = C_LFGList.GetApplicantMemberInfo(applicantID, memberIdx)
				if fullName then
					local name, realm = strsplit("-", fullName)
					if not realm or realm == "" then
						realm = GetNormalizedRealmName()
					end
					table.insert(names, name .. "-" .. realm)
				end
			end
		end
	end

	return names
end

local frame

local function CreateExportFrame()
	local f = CreateFrame("Frame", "QueueAnalyzerExportFrame", UIParent, "BasicFrameTemplateWithInset")
	f:SetSize(420, 480)
	f:SetPoint("CENTER")
	f:SetMovable(true)
	f:EnableMouse(true)
	f:RegisterForDrag("LeftButton")
	f:SetScript("OnDragStart", f.StartMoving)
	f:SetScript("OnDragStop", f.StopMovingOrSizing)
	f:SetClampedToScreen(true)
	tinsert(UISpecialFrames, "QueueAnalyzerExportFrame") -- Escape closes it

	f.title = f:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	f.title:SetPoint("LEFT", f.TitleBg, "LEFT", 5, 0)
	f.title:SetText("Queue Analyzer - Bewerber")

	f.hint = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	f.hint:SetPoint("TOPLEFT", 14, -30)
	f.hint:SetPoint("RIGHT", -14, 0)
	f.hint:SetJustifyH("LEFT")
	f.hint:SetText("Strg+A, Strg+C zum Kopieren. Nur sichtbar, wenn du Gruppenleiter mit Bewerbern bist.")

	local scrollFrame = CreateFrame("ScrollFrame", nil, f, "UIPanelScrollFrameTemplate")
	scrollFrame:SetPoint("TOPLEFT", 14, -50)
	scrollFrame:SetPoint("BOTTOMRIGHT", -30, 44)

	local editBox = CreateFrame("EditBox", "QueueAnalyzerExportEditBox", scrollFrame)
	editBox:SetMultiLine(true)
	editBox:SetFontObject(ChatFontNormal)
	editBox:SetWidth(360)
	editBox:SetAutoFocus(false)
	editBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	scrollFrame:SetScrollChild(editBox)
	f.editBox = editBox

	local refreshButton = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
	refreshButton:SetText("Aktualisieren")
	refreshButton:SetSize(120, 24)
	refreshButton:SetPoint("BOTTOM", 0, 10)
	refreshButton:SetScript("OnClick", function() QueueAnalyzer_RefreshExport() end)

	return f
end

function QueueAnalyzer_RefreshExport()
	if not frame then
		return
	end

	local names = GetApplicantNames()
	local text
	if #names == 0 then
		text = "(Keine Bewerber gefunden. Du musst Gruppenleiter einer Anzeige mit Bewerbern sein.)"
	else
		text = table.concat(names, "\n")
	end

	frame.editBox:SetText(text)
	frame.editBox:HighlightText()
	frame.editBox:SetFocus()
end

function QueueAnalyzer_ToggleExportFrame()
	if not frame then
		frame = CreateExportFrame()
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
SlashCmdList["QUEUEANALYZER"] = QueueAnalyzer_ToggleExportFrame

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
		rootDescription:CreateButton("Alle Bewerber kopieren (Queue Analyzer)", QueueAnalyzer_ToggleExportFrame)
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
	button:SetSize(150, 20)
	button:SetText("Bewerber kopieren")
	button:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -6, -4)
	button:SetScript("OnClick", QueueAnalyzer_ToggleExportFrame)
	panel.QueueAnalyzerButton = button
end

local loader = CreateFrame("Frame")
loader:RegisterEvent("ADDON_LOADED")
loader:SetScript("OnEvent", function(_, _, addonName)
	if addonName == "Blizzard_GroupFinder" then
		AddApplicationViewerButton()
	end
end)

-- Blizzard_GroupFinder may already be loaded by the time we get here
-- (e.g. after a /reload while the group finder was open).
if C_AddOns and C_AddOns.IsAddOnLoaded and C_AddOns.IsAddOnLoaded("Blizzard_GroupFinder") then
	AddApplicationViewerButton()
end
