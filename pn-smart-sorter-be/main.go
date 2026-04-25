// backend/main.go
// Run:
//   go mod init cbi-smartsorter
//   go get github.com/go-chi/chi/v5 github.com/go-chi/cors github.com/microsoft/go-mssqldb
//   go run main.go

package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	_ "github.com/microsoft/go-mssqldb"
)

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

type Config struct {
	DBHost     string
	DBName     string
	DBUser     string
	DBPassword string
	DBPort     string
	Port       string
	AstraAPI   string
}

func loadConfig() Config {
	return Config{
		DBHost:     getEnv("DB_HOST", "localhost"),
		DBName:     getEnv("DB_NAME", "whcomp"),
		DBUser:     getEnv("DB_USER", "sa"),
		DBPassword: getEnv("DB_PASSWORD", "admin"),
		DBPort:     getEnv("DB_PORT", "1433"),
		Port:       getEnv("PORT", "8080"),
		AstraAPI:   getEnv("ASTRA_API", "https://appext.incoe.astra.co.id/vendor_rating_infor/api"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ─────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────

func newDB(cfg Config) *sql.DB {
	dsn := fmt.Sprintf(
		"sqlserver://%s:%s@%s:%s?database=%s&connection+timeout=30",
		cfg.DBUser, cfg.DBPassword, cfg.DBHost, cfg.DBPort, cfg.DBName,
	)
	db, err := sql.Open("sqlserver", dsn)
	if err != nil {
		log.Fatalf("DB open error: %v", err)
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)
	if err = db.Ping(); err != nil {
		log.Fatalf("DB ping error: %v", err)
	}
	log.Printf("Connected to SQL Server  db=%s  host=%s", cfg.DBName, cfg.DBHost)
	return db
}

// ─────────────────────────────────────────────
// JSON helpers
// ─────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decodeBody(r *http.Request, v any) error {
	return json.NewDecoder(r.Body).Decode(v)
}

// ─────────────────────────────────────────────
// Astra DN API proxy
// ─────────────────────────────────────────────

// GET /api/dn/items/:dn
// Proxies: https://appext.incoe.astra.co.id/vendor_rating_infor/api/dn_json/{dn}
func handleDNItems(cfg Config) http.HandlerFunc {
	client := &http.Client{Timeout: 15 * time.Second}
	return func(w http.ResponseWriter, r *http.Request) {
		dn := strings.ToUpper(strings.TrimSpace(chi.URLParam(r, "dn")))
		if dn == "" {
			writeError(w, http.StatusBadRequest, "dn is required")
			return
		}

		url := fmt.Sprintf("%s/dn_json/%s", cfg.AstraAPI, dn)
		resp, err := client.Get(url)
		if err != nil {
			log.Printf("Astra API error: %v", err)
			writeError(w, http.StatusBadGateway, "Gagal menghubungi API eksternal.")
			return
		}
		defer resp.Body.Close()

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Gagal membaca respons API.")
			return
		}

		// Detect empty / no-results
		var parsed map[string]any
		if json.Unmarshal(body, &parsed) == nil {
			if results, ok := parsed["results"].([]any); ok && len(results) == 0 {
				writeError(w, http.StatusNotFound, "Nomor DN tidak terdaftar.")
				return
			}
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(body)
	}
}

// ─────────────────────────────────────────────
// Check DN in packing table
// ─────────────────────────────────────────────

// POST /api/dn/check  body: {"dn":"KSS007317A"}
func handleCheckDN(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			DN string `json:"dn"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid body")
			return
		}
		dn := strings.ToUpper(strings.TrimSpace(body.DN))

		var exists int
		err := db.QueryRowContext(r.Context(),
			`SELECT COUNT(1) FROM packing WHERE no_dn = @p1`, dn,
		).Scan(&exists)
		if err != nil {
			log.Printf("checkDN query error: %v", err)
			writeError(w, http.StatusInternalServerError, "DB error")
			return
		}

		if exists > 0 {
			writeJSON(w, http.StatusOK, map[string]any{
				"success": false,
				"message": "No. DN telah terdaftar packing. Silakan edit jika menginginkan.",
			})
		} else {
			writeJSON(w, http.StatusOK, map[string]any{"success": true})
		}
	}
}

// ─────────────────────────────────────────────
// Label summary  (qty already in detail_label_packing)
// ─────────────────────────────────────────────

// POST /api/dn/label-summary  body: {"dn":"KSS007317A"}
func handleLabelSummary(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			DN string `json:"dn"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid body")
			return
		}
		dn := strings.ToUpper(strings.TrimSpace(body.DN))

		rows, err := db.QueryContext(r.Context(), `
			SELECT
				part_number_label,
				no_dn,
				label,
				SUM(CAST(qty_label AS FLOAT)) AS qty_label
			FROM detail_label_packing
			WHERE no_dn LIKE @p1 + '%'
			GROUP BY part_number_label, no_dn, label
		`, dn)
		if err != nil {
			log.Printf("labelSummary query error: %v", err)
			writeError(w, http.StatusInternalServerError, "DB error")
			return
		}
		defer rows.Close()

		type Item struct {
			PartNumberLabel string  `json:"partNumberLabel"`
			NoDn            string  `json:"noDn"`
			Label           string  `json:"label"`
			QtyLabel        float64 `json:"qtyLabel"`
		}
		var items []Item
		for rows.Next() {
			var it Item
			if err := rows.Scan(&it.PartNumberLabel, &it.NoDn, &it.Label, &it.QtyLabel); err != nil {
				continue
			}
			items = append(items, it)
		}
		if items == nil {
			items = []Item{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": items})
	}
}

// ─────────────────────────────────────────────
// Label lookup  (labels master table)
// ─────────────────────────────────────────────

// POST /api/label/lookup  body: {"label":"..."}
// Mirrors CodeIgniter getLabelData():
//   - checks detail_label_packing for duplicates
//   - then looks up labels table (status=active)
func handleLabelLookup(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Label    string `json:"label"`
			Supplier string `json:"supplier"` // optional; sent from session on client if available
		}
		if err := decodeBody(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid body")
			return
		}
		label := strings.TrimSpace(body.Label)

		// 1. Duplicate check
		var dupCount int
		_ = db.QueryRowContext(r.Context(),
			`SELECT COUNT(1) FROM detail_label_packing WHERE label = @p1`, label,
		).Scan(&dupCount)
		if dupCount > 0 {
			writeJSON(w, http.StatusOK, map[string]any{
				"success": false,
				"message": "Label ini sudah diinput sebelumnya. Silakan input label yang berbeda.",
			})
			return
		}

		// 2. Lookup label
		query := `SELECT TOP 1 part_number, CAST(qty AS FLOAT) AS qty, label
				  FROM labels
				  WHERE label = @p1 AND status = 'active'`
		args := []any{label}

		// If supplier is known, filter by it (mirrors session()->get('supplier'))
		if body.Supplier != "" {
			query = `SELECT TOP 1 part_number, CAST(qty AS FLOAT) AS qty, label
					 FROM labels
					 WHERE label = @p1 AND status = 'active' AND supplier = @p2`
			args = append(args, body.Supplier)
		}

		var pn, lbl string
		var qty float64
		err := db.QueryRowContext(r.Context(), query, args...).Scan(&pn, &qty, &lbl)
		if err == sql.ErrNoRows {
			writeJSON(w, http.StatusOK, map[string]any{
				"success": false,
				"message": "Label tidak ditemukan atau tidak aktif.",
			})
			return
		}
		if err != nil {
			log.Printf("labelLookup query error: %v", err)
			writeError(w, http.StatusInternalServerError, "DB error")
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"success":     true,
			"partNumber":  pn,
			"qty":         qty,
			"label":       lbl,
		})
	}
}

// ─────────────────────────────────────────────
// Delete label
// ─────────────────────────────────────────────

// POST /api/label/delete  body: {"id":"...","dn":"...","qty":10,"partNumber":"..."}
func handleDeleteLabel(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID          string  `json:"id"`
			DN          string  `json:"dn"`
			Qty         float64 `json:"qty"`
			PartNumber  string  `json:"partNumber"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid body")
			return
		}

		tx, err := db.BeginTx(r.Context(), nil)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "DB error")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Find label
		var labelVal string
		err = tx.QueryRowContext(r.Context(),
			`SELECT label FROM detail_label_packing WHERE id = @p1 AND no_dn = @p2`,
			body.ID, body.DN,
		).Scan(&labelVal)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"success": false})
			return
		}

		// Delete
		_, err = tx.ExecContext(r.Context(),
			`DELETE FROM detail_label_packing WHERE id = @p1`, body.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "DB error")
			return
		}

		// Update detail_packing totals
		_, _ = tx.ExecContext(r.Context(), `
			UPDATE detail_packing
			SET
				total_qty_label = CAST(CAST(total_qty_label AS FLOAT) - @p1 AS VARCHAR(50)),
				status = 'Belum Terpenuhi'
			WHERE part_number_dn = @p2 AND no_dn = @p3
		`, body.Qty, body.PartNumber, body.DN)

		// Un-mark label in labels master
		_, _ = tx.ExecContext(r.Context(),
			`UPDATE labels SET packing = NULL WHERE label = @p1`, labelVal)

		if err = tx.Commit(); err != nil {
			writeError(w, http.StatusInternalServerError, "DB error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
	}
}

// ─────────────────────────────────────────────
// Save packing
// ─────────────────────────────────────────────

type PackingDetail struct {
	PartNumberDn  string  `json:"partNumberDn"`
	NoDnItem      string  `json:"noDnItem"`
	PoItem        string  `json:"poItem"`
	QtyDnItem     float64 `json:"qtyDnItem"`
	TotalQtyDn    float64 `json:"totalQtyDn"`
	TotalQtyLabel float64 `json:"totalQtyLabel"`
	Status        string  `json:"status"`
}

type InputtedLabel struct {
	Label      string  `json:"label"`
	PartNumber string  `json:"partNumber"`
	Qty        float64 `json:"qty"`
	NoDn       string  `json:"noDn"`
}

type SavePackingBody struct {
	MainDn         string          `json:"mainDn"`
	Po             string          `json:"po"`
	Details        []PackingDetail `json:"details"`
	InputtedLabels []InputtedLabel `json:"inputtedLabels"`
}

// POST /api/packing/save
// Mirrors CodeIgniter savePacking():
//   upsert packing → upsert detail_packing → insert detail_label_packing → mark labels
func handleSavePacking(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body SavePackingBody
		if err := decodeBody(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid body")
			return
		}
		if len(body.Details) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"success": false, "message": "Tidak ada data detail untuk disimpan.",
			})
			return
		}

		tx, err := db.BeginTx(r.Context(), nil)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "DB error")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Group details by DN
		detailsByDN := map[string][]PackingDetail{}
		for _, d := range body.Details {
			detailsByDN[d.NoDnItem] = append(detailsByDN[d.NoDnItem], d)
		}

		labelsByDN := map[string][]InputtedLabel{}
		for _, l := range body.InputtedLabels {
			labelsByDN[l.NoDn] = append(labelsByDN[l.NoDn], l)
		}

		for dn, details := range detailsByDN {
			po := details[0].PoItem

			// ── 1. Upsert packing header ──────────────────
			var packingCode string
			err := tx.QueryRowContext(r.Context(),
				`SELECT packing_code FROM packing WHERE no_dn = @p1`, dn,
			).Scan(&packingCode)

			if err == sql.ErrNoRows {
				// Generate packing code: PKG-{DN}-{timestamp}
				packingCode = fmt.Sprintf("PKG-%s-%d", dn, time.Now().UnixMilli())
				_, err = tx.ExecContext(r.Context(),
					`INSERT INTO packing (packing_code, no_dn, po, created_at)
					 VALUES (@p1, @p2, @p3, GETDATE())`,
					packingCode, dn, po)
				if err != nil {
					log.Printf("insert packing error: %v", err)
					writeError(w, http.StatusInternalServerError, "DB error (packing insert)")
					return
				}
			} else if err != nil {
				writeError(w, http.StatusInternalServerError, "DB error (packing query)")
				return
			} else {
				_, _ = tx.ExecContext(r.Context(),
					`UPDATE packing SET po = @p1 WHERE no_dn = @p2`, po, dn)
			}

			// ── 2. Upsert detail_packing per part ─────────
			for _, det := range details {
				var detID int
				e := tx.QueryRowContext(r.Context(), `
					SELECT id FROM detail_packing
					WHERE packing_code = @p1 AND no_dn = @p2 AND part_number_dn = @p3
				`, packingCode, dn, det.PartNumberDn).Scan(&detID)

				statusStr := det.Status
				totalQtyLabelStr := fmt.Sprintf("%g", det.TotalQtyLabel)
				totalQtyDnStr := fmt.Sprintf("%g", det.TotalQtyDn)

				if e == sql.ErrNoRows {
					_, err = tx.ExecContext(r.Context(), `
						INSERT INTO detail_packing
							(packing_code, no_dn, part_number_dn, total_qty_dn, total_qty_label, status)
						VALUES (@p1, @p2, @p3, @p4, @p5, @p6)
					`, packingCode, dn, det.PartNumberDn,
						totalQtyDnStr, totalQtyLabelStr, statusStr)
				} else if e == nil {
					_, err = tx.ExecContext(r.Context(), `
						UPDATE detail_packing
						SET total_qty_label = @p1, status = @p2
						WHERE id = @p3
					`, totalQtyLabelStr, statusStr, detID)
				}
				if err != nil {
					log.Printf("upsert detail_packing error: %v", err)
					writeError(w, http.StatusInternalServerError, "DB error (detail_packing)")
					return
				}
			}

			// ── 3. Insert detail_label_packing + mark labels ─
			for _, lbl := range labelsByDN[dn] {
				// Skip if already recorded
				var cnt int
				_ = tx.QueryRowContext(r.Context(),
					`SELECT COUNT(1) FROM detail_label_packing WHERE label = @p1`, lbl.Label,
				).Scan(&cnt)
				if cnt > 0 {
					continue
				}

				qtyStr := fmt.Sprintf("%g", lbl.Qty)
				_, err = tx.ExecContext(r.Context(), `
					INSERT INTO detail_label_packing
						(part_number_label, no_dn, label, qty_label)
					VALUES (@p1, @p2, @p3, @p4)
				`, lbl.PartNumber, dn, lbl.Label, qtyStr)
				if err != nil {
					log.Printf("insert detail_label_packing error: %v", err)
					writeError(w, http.StatusInternalServerError, "DB error (detail_label_packing)")
					return
				}

				// Mark label as packed
				_, _ = tx.ExecContext(r.Context(),
					`UPDATE labels SET packing = 'Yes' WHERE label = @p1`, lbl.Label)
			}
		}

		if err = tx.Commit(); err != nil {
			writeError(w, http.StatusInternalServerError, "DB commit error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
	}
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

func main() {
	cfg := loadConfig()
	db  := newDB(cfg)
	defer db.Close()

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins: []string{
			"http://localhost:3000",
			"https://*",
		},
		AllowedMethods: []string{"GET", "POST", "OPTIONS"},
		AllowedHeaders: []string{"Accept", "Content-Type", "Authorization"},
		MaxAge:         300,
	}))

	// DN
	r.Get("/api/dn/items/{dn}", handleDNItems(cfg))
	r.Post("/api/dn/check", handleCheckDN(db))
	r.Post("/api/dn/label-summary", handleLabelSummary(db))

	// Label
	r.Post("/api/label/lookup", handleLabelLookup(db))
	r.Post("/api/label/delete", handleDeleteLabel(db))

	// Packing
	r.Post("/api/packing/save", handleSavePacking(db))

	// Health
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		if err := db.Ping(); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"db": "unreachable"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "db": "connected"})
	})

	addr := ":" + cfg.Port
	log.Printf("CBI Smart Sorter API  →  http://localhost%s", addr)
	if err := http.ListenAndServe(addr, r); err != nil {
		log.Fatal(err)
	}
}