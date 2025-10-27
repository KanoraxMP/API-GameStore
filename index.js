// index.js (Previously server.js)
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

import multer from "multer";
import sharp from "sharp";
import { v2 as cloudinary } from "cloudinary";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------- MySQL Connection Pool ----------
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ---------- Cloudinary Config ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------- Multer (in-memory, 10MB) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
    if (!ok) return cb(new Error("Only JPEG/JPG/PNG/WEBP allowed"));
    cb(null, true);
  },
});

// ---------- Helpers ----------
async function uploadBufferToCloudinary(buffer, folder = "avatars") {
  return await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", format: "webp" },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

async function processImageToWebpSquare(inputBuffer) {
  return await sharp(inputBuffer)
    .resize(512, 512, { fit: "cover" })
    .toFormat("webp", { quality: 90 })
    .toBuffer();
}

//=================================================================
//                        ROUTE TEST
//=================================================================
// ---------- Test API ----------
app.get("/", (_, res) => res.send("API on Render 🚀"));

// ---------- Get all users ----------
app.get("/users", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT uid, username, email, password, imagepro, role FROM `User`"
    );
    res.json(rows);
  } catch (err) {
    console.error("Get all users error:", err);
    res.status(500).json("Database error");
  }
});

// ---------- Get user by id ----------
app.get("/users/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT uid, username, email, password, imagepro, role FROM `User` WHERE uid = ?",
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json("User not found");
    res.json(rows[0]);
  } catch (err) {
    console.error("Get user by id error:", err);
    res.status(500).json("Database error");
  }
});


//=================================================================
//                           USER ROUTE
//=================================================================

// ---------- Register User ----------
app.post("/register/user", upload.single("avatar"), async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) {
      return res.status(400).json("email, username, and password are required");
    }

    if (req.file && req.file.size > 10 * 1024 * 1024) {
      return res.status(413).json("ไฟล์รูปใหญ่เกิน 10MB");
    }

    let avatarUrl = null;
    if (req.file?.buffer) {
      const processed = await processImageToWebpSquare(req.file.buffer);
      const uploaded = await uploadBufferToCloudinary(processed, "avatars");
      avatarUrl = uploaded.secure_url;
    }

    const [result] = await pool.query(
      "INSERT INTO `User` (username, email, password, imagepro, role) VALUES (?, ?, ?, ?, ?)",
      [username, email, password, avatarUrl, "user"]
    );

    res.status(201).json({
      message: "User registered successfully",
      uid: result.insertId,
      imagepro : avatarUrl,
    });
  } catch (err) {
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json("ไฟล์รูปใหญ่เกิน 10MB");
    }
    console.error("Register error:", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json("Email already exists");
    }
    res.status(500).json(err.message || "Database error");
  }
});

// ---------- Login ----------
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json("username and password are required");
    }

    // หา user ใน DB
    const [rows] = await pool.query(
      "SELECT uid, username, email, password, imagepro, role FROM `User` WHERE username = ?",
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const user = rows[0];

    if (user.password !== password) {
      return res.status(401).json("Invalid username or password");
    }

    // Login
    res.json({
      message: "Login successful",
      user: {
        uid: user.uid,
        username: user.username,
        email: user.email,
        imapro: user.imagepro,
        // wallet_balance: user.wallet_balance,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json("Database error");
  }
});

// ---------- Update user (merge data) ----------
app.post("/users/update", upload.single("avatar"), async (req, res) => {
  try {
    const { uid, username } = req.body;

    if (!uid) {
      return res.status(400).json("uid is required");
    }

    // 1. ดึงข้อมูลเก่ามาก่อน
    const [rows] = await pool.query("SELECT * FROM `User` WHERE uid = ?", [uid]);
    if (rows.length === 0) return res.status(404).json("User not found");

    const oldUser = rows[0];

    // 2. Process avatar
    let avatarUrl = oldUser.imagepro;
    if (req.file?.buffer) {
      if (req.file.size > 10 * 1024 * 1024) {
        return res.status(413).json("ไฟล์รูปใหญ่เกิน 10MB");
      }
      const processed = await processImageToWebpSquare(req.file.buffer);
      const uploaded = await uploadBufferToCloudinary(processed, "avatars");
      avatarUrl = uploaded.secure_url;
    }

    // 3. Merge data
    const newUser = {
      username: username || oldUser.username,
      imagepro: avatarUrl, // ใช้ 'imagepro' ให้ตรงกับ db
    };

    // 4. UPDATE DB
    const [rs] = await pool.query(
      `UPDATE \`User\`
       SET username = ?, imagepro= ?
       WHERE uid = ?`,
      [
        newUser.username,
        newUser.imagepro, // แก้ไข: ใช้ newUser.imagepro
        uid,
      ]
    );

    if (rs.affectedRows === 0) return res.status(404).json("User Not Found");

    res.json({
      message: "User updated successfully",
      user: { uid, ...newUser },
    });
  } catch (e) {
    console.error("Update error:", e);
    res.status(500).json(e.message || "Database error");
  }
});

//=================================================================
//                         GAME ROUTES
//=================================================================

// ---------- Get all games (with category name) ----------
app.get("/games", async (req, res) => {
  try {
    // [FIXED] Re-typed query to remove hidden characters/non-breaking spaces
    // [V2-FIX] Forcing query to a single line to ensure no hidden characters.
    const [rows] = await pool.query(
      "SELECT g.*, c.name AS category_name FROM Games g LEFT JOIN Categories c ON g.category_id = c.category_id"
    );
    res.json(rows);
  } catch (err) {
    console.error("Get all games error:", err);
    res.status(500).json("Database error");
  }
});

// ---------- Get game by id (with category name) ----------
app.get("/games/:id", async (req, res) => {
  try {
    // [FIXED] Re-typed query to remove hidden characters/non-breaking spaces
    // [V2-FIX] Forcing query to a single line to ensure no hidden characters.
    const [rows] = await pool.query(
      "SELECT g.*, c.name AS category_name FROM Games g LEFT JOIN Categories c ON g.category_id = c.category_id WHERE g.game_id = ?",
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json("Game not found");
    res.json(rows[0]);
  } catch (err) {
    console.error("Get game by id error:", err);
    res.status(500).json("Database error");
  }
});

// ---------- Add new game ----------
app.post("/games", upload.single("image"), async (req, res) => {
  try {
    const { name, description, price, category_id } = req.body;

    // --- Validation ---
    if (!name || !price || !category_id) {
      return res.status(400).json("name, price, and category_id are required");
    }
    if (!req.file) {
      return res.status(400).json("image is required");
    }
    if (req.file.size > 10 * 1024 * 1024) {
      return res.status(413).json("ไฟล์รูปใหญ่เกิน 10MB");
    }
    // --- End Validation ---

    // 1. Process image
    const processed = await processImageToWebpSquare(req.file.buffer);
    // 2. Upload to Cloudinary in "games" folder
    const uploaded = await uploadBufferToCloudinary(processed, "games");
    const imageUrl = uploaded.secure_url;

    // 3. Insert into DB
    const [result] = await pool.query(
      "INSERT INTO `Games` (name, description, price, category_id, image_url) VALUES (?, ?, ?, ?, ?)",
      [name, description || null, price, category_id, imageUrl]
    );

    res.status(201).json({
      message: "Game created successfully",
      game_id: result.insertId,
      image_url: imageUrl,
    });

  } catch (err) {
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json("ไฟล์รูปใหญ่เกิน 10MB");
    }
    console.error("Add game error:", err);
    res.status(500).json(err.message || "Database error");
  }
});

// ---------- Update game (merge data) ----------
app.post("/games/update", upload.single("image"), async (req, res) => {
  try {
    const { game_id, name, description, price, category_id } = req.body;

    if (!game_id) {
      return res.status(400).json("game_id is required");
    }

    // 1. ดึงข้อมูลเกมเก่า
    const [rows] = await pool.query("SELECT * FROM `Games` WHERE game_id = ?", [game_id]);
    if (rows.length === 0) return res.status(404).json("Game not found");
    const oldGame = rows[0];

    // 2. Process new image (if any)
    let newImageUrl = oldGame.image_url;
    if (req.file?.buffer) {
      if (req.file.size > 10 * 1024 * 1024) {
        return res.status(413).json("ไฟล์รูปใหญ่เกิน 10MB");
      }
      const processed = await processImageToWebpSquare(req.file.buffer);
      const uploaded = await uploadBufferToCloudinary(processed, "games");
      newImageUrl = uploaded.secure_url;
    }

    // 3. Merge data (ใช้ ?? เพื่อให้สามารถอัปเดตเป็นค่าว่างได้)
    const updatedGame = {
      name: name || oldGame.name,
      description: description ?? oldGame.description,
      price: price || oldGame.price,
      category_id: category_id || oldGame.category_id,
      image_url: newImageUrl,
    };

    // 4. UPDATE DB
    const [result] = await pool.query(
      `UPDATE \`Games\` SET 
        name = ?, 
        description = ?, 
        price = ?, 
        category_id = ?, 
        image_url = ?
        WHERE game_id = ?`,
      [
        updatedGame.name,
        updatedGame.description,
        updatedGame.price,
        updatedGame.category_id,
        updatedGame.image_url,
        game_id,
      ]
    );

    if (result.affectedRows === 0) return res.status(404).json("Game Not Found (should not happen)");

    res.json({
      message: "Game updated successfully",
      game: { game_id, ...updatedGame },
    });

  } catch (err) {
    console.error("Update game error:", err);
    res.status(500).json(err.message || "Database error");
  }
});

// ---------- Delete game by id ----------
app.delete("/games/:id", async (req, res) => {
  try {
    const [result] = await pool.query(
      "DELETE FROM `Games` WHERE game_id = ?",
      [req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json("Game not found or already deleted");
    }

    res.json({ message: "Game deleted successfully" });

  } catch (err) {
    console.error("Delete game error:", err);
    // Handle foreign key constraint error if needed
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json("Cannot delete game, it is referenced by other data (e.g., in user library or cart)");
    }
    res.status(500).json("Database error");
  }
});


// ---------- Start Server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});


