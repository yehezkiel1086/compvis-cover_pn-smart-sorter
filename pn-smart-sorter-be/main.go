// backend/main.go
// Run with:  go run main.go
// Requires:  go get github.com/go-chi/chi/v5 github.com/go-chi/cors

package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
)

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type DNItemStatus string

const (
	StatusPending   DNItemStatus = "pending"
	StatusPartial   DNItemStatus = "partial"
	StatusFulfilled DNItemStatus = "fulfilled"
)

type DNItem struct {
	ID               string       `json:"id"`
	PartNumber       string       `json:"partNumber"`
	PONumber         string       `json:"poNumber"`
	Line             int          `json:"line"`
	WONumber         string       `json:"woNumber"`
	QtyDN            int          `json:"qtyDN"`
	QtyLabel         int          `json:"qtyLabel"`
	Status           DNItemStatus `json:"status"`
	CameraValidation *string      `json:"cameraValidation"`
}

type DNOverallStatus string

const (
	DNPending     DNOverallStatus = "pending"
	DNInProgress  DNOverallStatus = "in_progress"
	DNComplete    DNOverallStatus = "complete"
	DNDiscrepancy DNOverallStatus = "discrepancy"
)

type DN struct {
	DNNumber      string          `json:"dnNumber"`
	PackingSlip   string          `json:"packingSlip"`
	Supplier      string          `json:"supplier"`
	Date          string          `json:"date"`
	Items         []DNItem        `json:"items"`
	OverallStatus DNOverallStatus `json:"overallStatus"`
}

type ScanEvent struct {
	PartNumber string   `json:"partNumber"`
	Method     string   `json:"method"`     // "auto" | "manual"
	Confidence *float64 `json:"confidence"` // null for manual
	Note       string   `json:"note,omitempty"`
}

type CompletePayload struct {
	Status string `json:"status"` // "fulfilled" | "discrepancy"
	Note   string `json:"note,omitempty"`
	Items  []struct {
		PartNumber  string `json:"partNumber"`
		QtyRequired int    `json:"qtyRequired"`
		QtyScanned  int    `json:"qtyScanned"`
	} `json:"items"`
}

// ─────────────────────────────────────────────
// In-memory store  (swap for PostgreSQL in prod)
// ─────────────────────────────────────────────

type Store struct {
	mu  sync.RWMutex
	dns map[string]*DN
}

func NewStore() *Store {
	s := &Store{dns: make(map[string]*DN)}
	s.seed()
	return s
}

func (s *Store) seed() {
	// Sample data matching the existing system's format
	s.dns["KSS007317A"] = &DN{
		DNNumber:      "KSS007317A",
		PackingSlip:   "024/CBI/JUL/25",
		Supplier:      "PT Supplier Prima Utama",
		Date:          time.Now().Format(time.RFC3339),
		OverallStatus: DNPending,
		Items: []DNItem{
			{
				ID: "1", PartNumber: "W_CV01_D31LXXX_C01N_NL_DG00",
				PONumber: "SUB250432", Line: 1, WONumber: "PKSC11156",
				QtyDN: 135, QtyLabel: 0, Status: StatusPending,
			},
			{
				ID: "2", PartNumber: "W_CV01_D26RXXX_C03N_NL_DG00",
				PONumber: "SUB250433", Line: 2, WONumber: "PKSC11157",
				QtyDN: 50, QtyLabel: 0, Status: StatusPending,
			},
		},
	}
}

func (s *Store) GetDN(number string) (*DN, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.dns[number]
	return d, ok
}

func (s *Store) RecordScan(dnNumber string, event ScanEvent) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.dns[dnNumber]
	if !ok {
		return false
	}
	for i := range d.Items {
		if d.Items[i].PartNumber == event.PartNumber {
			d.Items[i].QtyLabel++
			if d.Items[i].QtyLabel >= d.Items[i].QtyDN {
				d.Items[i].Status = StatusFulfilled
			} else {
				d.Items[i].Status = StatusPartial
			}
			label := event.Method
			d.Items[i].CameraValidation = &label
			break
		}
	}
	d.OverallStatus = DNInProgress
	return true
}

func (s *Store) CompleteDN(dnNumber string, payload CompletePayload) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.dns[dnNumber]
	if !ok {
		return false
	}
	if payload.Status == "discrepancy" {
		d.OverallStatus = DNDiscrepancy
	} else {
		d.OverallStatus = DNComplete
	}
	return true
}

// ─────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func handleGetDN(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		number := chi.URLParam(r, "number")
		dn, ok := store.GetDN(number)
		if !ok {
			writeError(w, http.StatusNotFound, "DN not found")
			return
		}
		writeJSON(w, http.StatusOK, dn)
	}
}

func handleRecordScan(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		number := chi.URLParam(r, "number")
		var event ScanEvent
		if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if !store.RecordScan(number, event) {
			writeError(w, http.StatusNotFound, "DN not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func handleCompleteDN(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		number := chi.URLParam(r, "number")
		var payload CompletePayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if !store.CompleteDN(number, payload) {
			writeError(w, http.StatusNotFound, "DN not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

func main() {
	store := NewStore()
	r := chi.NewRouter()

	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"http://localhost:3000", "https://*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: false,
		MaxAge:           300,
	}))

	r.Route("/api/dn/{number}", func(r chi.Router) {
		r.Get("/", handleGetDN(store))
		r.Post("/scan", handleRecordScan(store))
		r.Post("/complete", handleCompleteDN(store))
	})

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	addr := ":8080"
	log.Printf("CBI Smart Sorter API listening on %s", addr)
	if err := http.ListenAndServe(addr, r); err != nil {
		log.Fatal(err)
	}
}
