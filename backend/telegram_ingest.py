import json
import logging
import os
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Dict

from dotenv import load_dotenv
from telegram import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
    Update,
)
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    ConversationHandler,
    ExtBot,
    MessageHandler,
    filters,
)

import conversations

# Setup logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

# Paths & Environment Setup
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

FACILITIES_PATH = BASE_DIR / "data" / "facilities.json"
MATERIALS_PATH = BASE_DIR / "data" / "materials.json"

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

# Predefined options list loaded from materials.json
def get_known_materials() -> list:
    if MATERIALS_PATH.exists():
        with open(MATERIALS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return list(data.keys())
    return ["fly_ash", "steel_slag", "foundry_sand", "textile_dyeing_sludge", "rice_husk"]

# Conversation States
(
    ID,
    NAME,
    CLUSTER,
    COORDS,
    INDUSTRY,
    CUSTOM_INDUSTRY,
    PERSONA,
    URGENCY,
    HAZARD,
    # Outputs Flow
    OUT_NAME,
    CUSTOM_OUT_NAME,
    OUT_QTY,
    OUT_PURITY,
    OUT_ASK_PRICE,
    OUT_FLOOR_PRICE,
    OUT_STORAGE,
    OUT_MORE,
    # Inputs Flow
    IN_NAME,
    CUSTOM_IN_NAME,
    IN_QTY,
    IN_TARGET_PRICE,
    IN_CEILING_PRICE,
    IN_MORE,
    # Final Confirmation
    CONFIRMATION,
    # Contact number (asked after hazard license)
    PHONE,
) = range(25)


# Transcript logging -- every bot message and user reply is stored per chat
# so the web dashboard can show the full conversation.
class LoggingBot(ExtBot):
    async def send_message(self, chat_id, text, *args, **kwargs):
        conversations.append(chat_id, "bot", text)
        return await super().send_message(chat_id, text, *args, **kwargs)

    async def edit_message_text(self, text, chat_id=None, *args, **kwargs):
        if chat_id is not None:
            conversations.append(chat_id, "bot", text)
        return await super().edit_message_text(text, chat_id, *args, **kwargs)


async def log_incoming(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat = update.effective_chat
    if not chat:
        return
    if update.callback_query:
        query = update.callback_query
        label = query.data
        markup = query.message.reply_markup if query.message else None
        if markup:
            for row in markup.inline_keyboard:
                for btn in row:
                    if btn.callback_data == query.data:
                        label = btn.text
        conversations.append(chat.id, "user", label, kind="button")
    elif update.message:
        msg = update.message
        if msg.contact:
            conversations.append(chat.id, "user", msg.contact.phone_number, kind="contact")
        elif msg.location:
            conversations.append(chat.id, "user", f"{msg.location.latitude} {msg.location.longitude}", kind="location")
        elif msg.text:
            conversations.append(chat.id, "user", msg.text)


# Utility Functions for JSON Persistence
def load_json(filepath: Path) -> Any:
    if filepath.exists():
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    return [] if filepath.name == "facilities.json" else {}


def save_json(filepath: Path, data: Any) -> None:
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def upsert_facility(facility_data: Dict[str, Any]) -> None:
    facilities = load_json(FACILITIES_PATH)
    updated = False
    for idx, fac in enumerate(facilities):
        if fac.get("id") == facility_data["id"]:
            facilities[idx] = facility_data
            updated = True
            break
    if not updated:
        facilities.append(facility_data)
    save_json(FACILITIES_PATH, facilities)


def upsert_materials_from_lists(outputs: list, inputs: list) -> None:
    materials = load_json(MATERIALS_PATH)
    all_items = outputs + inputs

    for item in all_items:
        mat_key = item.get("material")
        if mat_key and mat_key not in materials:
            materials[mat_key] = {
                "name": mat_key.replace("_", " ").title(),
                "category": "unclassified",
                "virgin_price_inr_per_t": 2000,
                "virgin_co2_t_per_t": 0.5,
                "disposal_cost_inr_per_t": 300,
                "hazard_class": "none",
                "price_band": [100, 1000],
                "substitutes_for": "general raw materials",
                "note": "Dynamically added via Telegram ingestion bot.",
            }
    save_json(MATERIALS_PATH, materials)


# Handler Functions
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.clear()
    context.user_data["outputs"] = []
    context.user_data["inputs"] = []

    await update.message.reply_text(
        "👋 Welcome to **Mycelium Facility Ingestion Bot**!\n\n"
        "Let's register or update a facility in `facilities.json`.\n"
        "Please enter the unique **Facility ID** (e.g., `peenya_foundry`):"
    )
    return ID


async def get_id(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    facility_id = update.message.text.strip().lower().replace(" ", "_")
    context.user_data["id"] = facility_id

    # Common Facility Names / Preset Options
    keyboard = [
        [InlineKeyboardButton("Bengaluru Craft Brewery", callback_data="Bengaluru Craft Brewing Co.")],
        [InlineKeyboardButton("Peenya Precision Foundry Works", callback_data="Peenya Precision Foundry Works")],
        [InlineKeyboardButton("Hosur PaveTech Construction", callback_data="Hosur PaveTech Construction Blocks")],
        [InlineKeyboardButton("✏️ Other (Type Custom Name)", callback_data="other")],
    ]
    await update.message.reply_text(
        "Select or type the **Facility Name**:",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return NAME


async def get_name(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        query = update.callback_query
        await query.answer()
        if query.data == "other":
            await query.edit_message_text("Please type your custom **Facility Name**:")
            return NAME
        context.user_data["name"] = query.data
        msg_func = query.edit_message_text
    else:
        context.user_data["name"] = update.message.text.strip()
        msg_func = update.message.reply_text

    keyboard = [
        [InlineKeyboardButton("Peenya/Bengaluru", callback_data="Peenya/Bengaluru")],
        [InlineKeyboardButton("Hosur", callback_data="Hosur"), InlineKeyboardButton("Tiruppur", callback_data="Tiruppur")],
        [InlineKeyboardButton("Jamshedpur", callback_data="Jamshedpur"), InlineKeyboardButton("Bellary-Hospet", callback_data="Bellary-Hospet")],
        [InlineKeyboardButton("Mundra", callback_data="Mundra"), InlineKeyboardButton("✏️ Other (Type Custom Cluster)", callback_data="other")],
    ]
    await msg_func(
        "Select the **Cluster/Region**:",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return CLUSTER


async def get_cluster(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        query = update.callback_query
        await query.answer()
        if query.data == "other":
            await query.edit_message_text("Please type your custom **Cluster/Region**:")
            return CLUSTER
        context.user_data["cluster"] = query.data
        msg_func = query.edit_message_text
    else:
        context.user_data["cluster"] = update.message.text.strip()
        msg_func = update.message.reply_text

    await msg_func(
        "Enter **Latitude and Longitude** (e.g., `13.031 77.517`) or send a Location pin clip:"
    )
    return COORDS


async def get_coords(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.message.location:
        lat = update.message.location.latitude
        lon = update.message.location.longitude
    else:
        parts = update.message.text.replace(",", " ").split()
        try:
            lat = float(parts[0])
            lon = float(parts[1])
        except Exception:
            await update.message.reply_text("❌ Invalid format. Enter as `lat lon` (e.g., `13.031 77.517`):")
            return COORDS

    context.user_data["lat"] = lat
    context.user_data["lon"] = lon

    keyboard = [
        [InlineKeyboardButton("Metallurgical", callback_data="metallurgical"), InlineKeyboardButton("Cement", callback_data="cement")],
        [InlineKeyboardButton("Energy", callback_data="energy"), InlineKeyboardButton("Food & Beverage", callback_data="food_beverage")],
        [InlineKeyboardButton("Textile", callback_data="textile"), InlineKeyboardButton("Construction Materials", callback_data="construction_materials")],
        [InlineKeyboardButton("✏️ Other...", callback_data="other")],
    ]
    await update.message.reply_text(
        "Select the **Industry Sector**:",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return INDUSTRY


async def get_industry(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "other":
        await query.edit_message_text("Please type the **Custom Industry Sector**:")
        return CUSTOM_INDUSTRY

    context.user_data["industry"] = query.data
    return await ask_persona(query.edit_message_text)


async def get_custom_industry(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data["industry"] = update.message.text.strip().lower().replace(" ", "_")
    return await ask_persona(update.message.reply_text)


async def ask_persona(reply_func) -> int:
    keyboard = [
        [InlineKeyboardButton("Cost-obsessed, skeptical owner", callback_data="Cost-obsessed, skeptical owner")],
        [InlineKeyboardButton("Compliance-focused manager", callback_data="Compliance-focused manager")],
        [InlineKeyboardButton("Data-driven procurement lead", callback_data="Data-driven procurement lead")],
        [InlineKeyboardButton("✏️ Other (Type Custom Persona)", callback_data="other")],
    ]
    await reply_func(
        "Select the **Persona/Negotiation Profile**:",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return PERSONA


async def get_persona(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        query = update.callback_query
        await query.answer()
        if query.data == "other":
            await query.edit_message_text("Please type your custom **Persona Description**:")
            return PERSONA
        context.user_data["persona"] = query.data
        msg_func = query.edit_message_text
    else:
        context.user_data["persona"] = update.message.text.strip()
        msg_func = update.message.reply_text

    keyboard = [
        [InlineKeyboardButton("Low", callback_data="low")],
        [InlineKeyboardButton("Medium", callback_data="medium")],
        [InlineKeyboardButton("High", callback_data="high")],
    ]
    await msg_func(
        "Select the **Urgency Level**:",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return URGENCY


async def get_urgency(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    context.user_data["urgency"] = query.data

    keyboard = [
        [InlineKeyboardButton("Yes", callback_data="yes"), InlineKeyboardButton("No", callback_data="no")],
    ]
    await query.edit_message_text(
        f"Selected Urgency: **{query.data}**\n\nHolds a valid **Hazard License**?",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return HAZARD


async def get_hazard(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    context.user_data["hazard_license"] = (query.data == "yes")

    await query.edit_message_text(f"Hazard License: **{query.data}**")
    keyboard = [[KeyboardButton("📱 Share my number", request_contact=True)]]
    await query.message.reply_text(
        "📞 Please share your **Contact Number** (tap the button or type it, e.g. `+91 98765 43210`).\n"
        "We'll use it to reach you with price offers for your materials.",
        reply_markup=ReplyKeyboardMarkup(keyboard, one_time_keyboard=True, resize_keyboard=True),
    )
    return PHONE


async def get_phone(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.message.contact:
        phone = update.message.contact.phone_number
    else:
        phone = update.message.text.strip()
        digits = "".join(ch for ch in phone if ch.isdigit())
        if not 8 <= len(digits) <= 15:
            await update.message.reply_text("❌ That doesn't look like a valid number. Please type it again (e.g. `+91 98765 43210`):")
            return PHONE
    if not phone.startswith("+") and len("".join(ch for ch in phone if ch.isdigit())) > 10:
        phone = "+" + phone
    context.user_data["phone"] = phone

    await update.message.reply_text(f"✅ Contact number saved: {phone}", reply_markup=ReplyKeyboardRemove())

    keyboard = [
        [InlineKeyboardButton("➕ Add Output Material", callback_data="add_output")],
        [InlineKeyboardButton("➡️ Skip Outputs", callback_data="skip_output")],
    ]
    await update.message.reply_text(
        "📦 **OUTPUTS SECTION** (Materials generated by facility):",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return OUT_NAME


# --- OUTPUTS FLOW ---
async def start_output_item(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "skip_output":
        keyboard = [
            [InlineKeyboardButton("➕ Add Input Material", callback_data="add_input")],
            [InlineKeyboardButton("➡️ Skip Inputs", callback_data="skip_input")],
        ]
        await query.edit_message_text(
            "📥 **INPUTS SECTION** (Materials required by facility):",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
        return IN_NAME

    context.user_data["temp_out"] = {}
    known_mats = get_known_materials()
    keyboard = []
    for i in range(0, len(known_mats), 2):
        row = [InlineKeyboardButton(known_mats[i], callback_data=known_mats[i])]
        if i + 1 < len(known_mats):
            row.append(InlineKeyboardButton(known_mats[i + 1], callback_data=known_mats[i + 1]))
        keyboard.append(row)
    keyboard.append([InlineKeyboardButton("✏️ Other...", callback_data="other")])

    await query.edit_message_text(
        "Select the **Output Material**:",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return OUT_QTY


async def get_out_qty(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        query = update.callback_query
        await query.answer()
        if query.data == "other":
            await query.edit_message_text("Type the custom **Output Material Name**:")
            return CUSTOM_OUT_NAME
        context.user_data["temp_out"]["material"] = query.data
        msg_func = query.edit_message_text
    else:
        context.user_data["temp_out"]["material"] = update.message.text.strip().lower().replace(" ", "_")
        msg_func = update.message.reply_text

    keyboard = [
        [InlineKeyboardButton("50", callback_data="50"), InlineKeyboardButton("100", callback_data="100"), InlineKeyboardButton("200", callback_data="200")],
        [InlineKeyboardButton("500", callback_data="500"), InlineKeyboardButton("1000", callback_data="1000"), InlineKeyboardButton("✏️ Other...", callback_data="other")],
    ]
    await msg_func("Select **Quantity generated (tonnes/month)**:", reply_markup=InlineKeyboardMarkup(keyboard))
    return OUT_PURITY


async def get_custom_out_name(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data["temp_out"]["material"] = update.message.text.strip().lower().replace(" ", "_")
    keyboard = [
        [InlineKeyboardButton("50", callback_data="50"), InlineKeyboardButton("100", callback_data="100"), InlineKeyboardButton("200", callback_data="200")],
        [InlineKeyboardButton("500", callback_data="500"), InlineKeyboardButton("1000", callback_data="1000"), InlineKeyboardButton("✏️ Other...", callback_data="other")],
    ]
    await update.message.reply_text("Select **Quantity generated (tonnes/month)**:", reply_markup=InlineKeyboardMarkup(keyboard))
    return OUT_PURITY


async def get_out_purity(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        query = update.callback_query
        await query.answer()
        if query.data == "other":
            await query.edit_message_text("Type the custom **Quantity in Tonnes**:")
            return OUT_PURITY
        context.user_data["temp_out"]["qty_t_per_month"] = float(query.data)
        msg_func = query.edit_message_text
    else:
        try:
            context.user_data["temp_out"]["qty_t_per_month"] = float(update.message.text.strip())
        except ValueError:
            await update.message.reply_text("❌ Enter a valid number:")
            return OUT_PURITY
        msg_func = update.message.reply_text

    keyboard = [
        [InlineKeyboardButton("0.70", callback_data="0.70"), InlineKeyboardButton("0.80", callback_data="0.80")],
        [InlineKeyboardButton("0.90", callback_data="0.90"), InlineKeyboardButton("0.95", callback_data="0.95")],
        [InlineKeyboardButton("✏️ Other...", callback_data="other")],
    ]
    await msg_func("Select **Material Purity**:", reply_markup=InlineKeyboardMarkup(keyboard))
    return OUT_ASK_PRICE


async def get_out_ask_price(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        query = update.callback_query
        await query.answer()
        if query.data == "other":
            await query.edit_message_text("Type the custom **Purity (0.0 - 1.0)**:")
            return OUT_ASK_PRICE
        context.user_data["temp_out"]["purity"] = float(query.data)
        msg_func = query.edit_message_text
    else:
        try:
            context.user_data["temp_out"]["purity"] = float(update.message.text.strip())
        except ValueError:
            await update.message.reply_text("❌ Enter a float between 0.0 and 1.0:")
            return OUT_ASK_PRICE
        msg_func = update.message.reply_text

    await msg_func("💰 **MONEY INPUT**: Type the **Asking Price** in INR per tonne (e.g., `380`):")
    return OUT_FLOOR_PRICE


async def get_out_floor_price(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    try:
        context.user_data["temp_out"]["ask_price_inr_per_t"] = float(update.message.text.strip())
    except ValueError:
        await update.message.reply_text("❌ Enter a numerical price in INR:")
        return OUT_FLOOR_PRICE

    await update.message.reply_text("💰 **MONEY INPUT**: Type the minimum **Floor Price** in INR per tonne (e.g., `220`):")
    return OUT_STORAGE


async def get_out_storage(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    try:
        context.user_data["temp_out"]["floor_price_inr_per_t"] = float(update.message.text.strip())
    except ValueError:
        await update.message.reply_text("❌ Enter a numerical price in INR:")
        return OUT_STORAGE

    keyboard = [
        [InlineKeyboardButton("1 Day", callback_data="1"), InlineKeyboardButton("7 Days", callback_data="7"), InlineKeyboardButton("30 Days", callback_data="30")],
        [InlineKeyboardButton("60 Days", callback_data="60"), InlineKeyboardButton("90 Days", callback_data="90"), InlineKeyboardButton("✏️ Other...", callback_data="other")],
    ]
    await update.message.reply_text("Select maximum **Storage Days**:", reply_markup=InlineKeyboardMarkup(keyboard))
    return OUT_MORE


async def save_out_item(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        query = update.callback_query
        await query.answer()
        if query.data == "other":
            await query.edit_message_text("Type custom **Storage Days**:")
            return OUT_MORE
        context.user_data["temp_out"]["storage_days"] = int(query.data)
        msg_func = query.edit_message_text
    else:
        try:
            context.user_data["temp_out"]["storage_days"] = int(update.message.text.strip())
        except ValueError:
            await update.message.reply_text("❌ Enter a valid number of days:")
            return OUT_MORE
        msg_func = update.message.reply_text

    context.user_data["outputs"].append(context.user_data["temp_out"])
    context.user_data.pop("temp_out", None)

    keyboard = [
        [InlineKeyboardButton("➕ Add Another Output", callback_data="add_output")],
        [InlineKeyboardButton("➡️ Proceed to Inputs", callback_data="skip_output")],
    ]
    await msg_func("✅ Output material recorded!\nAdd another **Output**?", reply_markup=InlineKeyboardMarkup(keyboard))
    return OUT_NAME


# --- INPUTS FLOW ---
async def start_input_item(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data in ["skip_input", "skip_output"]:
        return await show_summary(query.edit_message_text, context)

    context.user_data["temp_in"] = {}
    known_mats = get_known_materials()
    keyboard = []
    for i in range(0, len(known_mats), 2):
        row = [InlineKeyboardButton(known_mats[i], callback_data=known_mats[i])]
        if i + 1 < len(known_mats):
            row.append(InlineKeyboardButton(known_mats[i + 1], callback_data=known_mats[i + 1]))
        keyboard.append(row)
    keyboard.append([InlineKeyboardButton("✏️ Other...", callback_data="other")])

    await query.edit_message_text("Select the **Input Material**:", reply_markup=InlineKeyboardMarkup(keyboard))
    return IN_QTY


async def get_in_qty(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        query = update.callback_query
        await query.answer()
        if query.data == "other":
            await query.edit_message_text("Type custom **Input Material Name**:")
            return CUSTOM_IN_NAME
        context.user_data["temp_in"]["material"] = query.data
        msg_func = query.edit_message_text
    else:
        context.user_data["temp_in"]["material"] = update.message.text.strip().lower().replace(" ", "_")
        msg_func = update.message.reply_text

    keyboard = [
        [InlineKeyboardButton("100", callback_data="100"), InlineKeyboardButton("300", callback_data="300"), InlineKeyboardButton("500", callback_data="500")],
        [InlineKeyboardButton("800", callback_data="800"), InlineKeyboardButton("1000", callback_data="1000"), InlineKeyboardButton("✏️ Other...", callback_data="other")],
    ]
    await msg_func("Select **Required Quantity (tonnes/month)**:", reply_markup=InlineKeyboardMarkup(keyboard))
    return IN_TARGET_PRICE


async def get_custom_in_name(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data["temp_in"]["material"] = update.message.text.strip().lower().replace(" ", "_")
    keyboard = [
        [InlineKeyboardButton("100", callback_data="100"), InlineKeyboardButton("300", callback_data="300"), InlineKeyboardButton("500", callback_data="500")],
        [InlineKeyboardButton("800", callback_data="800"), InlineKeyboardButton("1000", callback_data="1000"), InlineKeyboardButton("✏️ Other...", callback_data="other")],
    ]
    await update.message.reply_text("Select **Required Quantity (tonnes/month)**:", reply_markup=InlineKeyboardMarkup(keyboard))
    return IN_TARGET_PRICE


async def get_in_target_price(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        query = update.callback_query
        await query.answer()
        if query.data == "other":
            await query.edit_message_text("Type custom **Quantity in Tonnes**:")
            return IN_TARGET_PRICE
        context.user_data["temp_in"]["qty_t_per_month"] = float(query.data)
        msg_func = query.edit_message_text
    else:
        try:
            context.user_data["temp_in"]["qty_t_per_month"] = float(update.message.text.strip())
        except ValueError:
            await update.message.reply_text("❌ Enter a valid number:")
            return IN_TARGET_PRICE
        msg_func = update.message.reply_text

    await msg_func("💰 **MONEY INPUT**: Type the **Target Price** in INR per tonne (e.g., `260`):")
    return IN_CEILING_PRICE


async def get_in_ceiling_price(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    try:
        context.user_data["temp_in"]["target_price_inr_per_t"] = float(update.message.text.strip())
    except ValueError:
        await update.message.reply_text("❌ Enter a numerical price in INR:")
        return IN_CEILING_PRICE

    await update.message.reply_text("💰 **MONEY INPUT**: Type maximum **Ceiling Price** in INR per tonne (e.g., `360`):")
    return IN_MORE


async def save_in_item(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    try:
        context.user_data["temp_in"]["ceiling_price_inr_per_t"] = float(update.message.text.strip())
    except ValueError:
        await update.message.reply_text("❌ Enter a numerical price in INR:")
        return IN_MORE

    context.user_data["inputs"].append(context.user_data["temp_in"])
    context.user_data.pop("temp_in", None)

    keyboard = [
        [InlineKeyboardButton("➕ Add Another Input", callback_data="add_input")],
        [InlineKeyboardButton("➡️ Finish & Review", callback_data="skip_input")],
    ]
    await update.message.reply_text("✅ Input material recorded!\nAdd another **Input**?", reply_markup=InlineKeyboardMarkup(keyboard))
    return IN_NAME


async def show_summary(msg_func, context) -> int:
    summary = json.dumps(context.user_data, indent=2)
    keyboard = [
        [InlineKeyboardButton("✅ Confirm & Save", callback_data="confirm")],
        [InlineKeyboardButton("❌ Cancel", callback_data="cancel")],
    ]
    await msg_func(
        f"📋 **Summary of Facility Entry**:\n```json\n{summary}\n```\nConfirm submission?",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="Markdown",
    )
    return CONFIRMATION


# --- CONFIRMATION ---
async def confirm_and_save(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "confirm":
        facility_data = dict(context.user_data)
        facility_data.pop("temp_out", None)
        facility_data.pop("temp_in", None)
        user = update.effective_user
        facility_data["source"] = "telegram"
        facility_data["telegram_chat_id"] = update.effective_chat.id
        facility_data["telegram_username"] = user.username if user else None
        facility_data["registered_at"] = datetime.now(timezone.utc).isoformat()

        upsert_facility(facility_data)
        upsert_materials_from_lists(facility_data.get("outputs", []), facility_data.get("inputs", []))

        await query.edit_message_text("✅ **Successfully updated `facilities.json` and synced `materials.json`**!")
    else:
        await query.edit_message_text("❌ Action cancelled.")

    return ConversationHandler.END


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await update.message.reply_text("Process cancelled.")
    return ConversationHandler.END


def main():
    if not TELEGRAM_BOT_TOKEN:
        raise ValueError("TELEGRAM_BOT_TOKEN environment variable is not set.")

    app = Application.builder().bot(LoggingBot(TELEGRAM_BOT_TOKEN)).build()
    # group -1 runs before the conversation handler, so every incoming update is logged
    app.add_handler(MessageHandler(filters.ALL, log_incoming), group=-1)
    app.add_handler(CallbackQueryHandler(log_incoming), group=-1)

    conv_handler = ConversationHandler(
        entry_points=[CommandHandler("start", start)],
        states={
            ID: [MessageHandler(filters.TEXT & ~filters.COMMAND, get_id)],
            NAME: [CallbackQueryHandler(get_name), MessageHandler(filters.TEXT & ~filters.COMMAND, get_name)],
            CLUSTER: [CallbackQueryHandler(get_cluster), MessageHandler(filters.TEXT & ~filters.COMMAND, get_cluster)],
            COORDS: [MessageHandler(filters.TEXT | filters.LOCATION, get_coords)],
            INDUSTRY: [CallbackQueryHandler(get_industry)],
            CUSTOM_INDUSTRY: [MessageHandler(filters.TEXT & ~filters.COMMAND, get_custom_industry)],
            PERSONA: [CallbackQueryHandler(get_persona), MessageHandler(filters.TEXT & ~filters.COMMAND, get_persona)],
            URGENCY: [CallbackQueryHandler(get_urgency)],
            HAZARD: [CallbackQueryHandler(get_hazard)],
            PHONE: [MessageHandler(filters.CONTACT | (filters.TEXT & ~filters.COMMAND), get_phone)],
            # Outputs Flow
            OUT_NAME: [CallbackQueryHandler(start_output_item)],
            OUT_QTY: [CallbackQueryHandler(get_out_qty), MessageHandler(filters.TEXT & ~filters.COMMAND, get_out_qty)],
            CUSTOM_OUT_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, get_custom_out_name)],
            OUT_PURITY: [CallbackQueryHandler(get_out_purity), MessageHandler(filters.TEXT & ~filters.COMMAND, get_out_purity)],
            OUT_ASK_PRICE: [CallbackQueryHandler(get_out_ask_price), MessageHandler(filters.TEXT & ~filters.COMMAND, get_out_ask_price)],
            OUT_FLOOR_PRICE: [MessageHandler(filters.TEXT & ~filters.COMMAND, get_out_floor_price)],
            OUT_STORAGE: [MessageHandler(filters.TEXT & ~filters.COMMAND, get_out_storage)],
            OUT_MORE: [CallbackQueryHandler(save_out_item), MessageHandler(filters.TEXT & ~filters.COMMAND, save_out_item)],
            # Inputs Flow
            IN_NAME: [CallbackQueryHandler(start_input_item)],
            IN_QTY: [CallbackQueryHandler(get_in_qty), MessageHandler(filters.TEXT & ~filters.COMMAND, get_in_qty)],
            CUSTOM_IN_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, get_custom_in_name)],
            IN_TARGET_PRICE: [CallbackQueryHandler(get_in_target_price), MessageHandler(filters.TEXT & ~filters.COMMAND, get_in_target_price)],
            IN_CEILING_PRICE: [MessageHandler(filters.TEXT & ~filters.COMMAND, get_in_ceiling_price)],
            IN_MORE: [MessageHandler(filters.TEXT & ~filters.COMMAND, save_in_item)],
            # Confirmation
            CONFIRMATION: [CallbackQueryHandler(confirm_and_save)],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )

    app.add_handler(conv_handler)
    logger.info("Telegram Bot running...")
    app.run_polling()


if __name__ == "__main__":
    main()