//go:build ignore

// Command doccheck walks a Go module and reports exported symbols —
// functions, methods, types, consts/vars, and exported interface methods —
// that lack a godoc comment, plus packages missing a package-level comment.
//
// Usage:
//
//	go run scripts/doccheck.go [-list] [-max N] [path]
//
// path defaults to "." (the whole repo). -list prints file:line: Symbol for
// every undocumented symbol. -max N (default 0) makes the command exit 1 if
// the total missing count exceeds N; `make doc-check` runs this with
// -max 0, i.e. it fails on any gap at all.
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var skipDirs = map[string]bool{
	"node_modules": true,
	"frontend":     true,
	".git":         true,
	"tmp":          true,
	"bin":          true,
}

type missingSym struct {
	pos  token.Position
	name string
}

type pkgResult struct {
	dir string

	exported   int
	documented int

	ifaceMethods    int
	ifaceDocumented int

	missing    []missingSym
	pkgDocMiss bool
}

func main() {
	listFlag := flag.Bool("list", false, "print file:line: Symbol for each undocumented symbol")
	maxFlag := flag.Int("max", 0, "exit 1 if total missing > N")
	flag.Parse()

	root := "."
	if flag.NArg() > 0 {
		root = flag.Arg(0)
	}

	fset := token.NewFileSet()
	pkgDirs := map[string][]string{} // dir -> go files

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if skipDirs[info.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, "_test.go") || !strings.HasSuffix(path, ".go") {
			return nil
		}
		dir := filepath.Dir(path)
		pkgDirs[dir] = append(pkgDirs[dir], path)
		return nil
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	var dirs []string
	for d := range pkgDirs {
		dirs = append(dirs, d)
	}
	sort.Strings(dirs)

	var results []*pkgResult
	var totalExp, totalDoc, totalIfaceExp, totalIfaceDoc int

	for _, dir := range dirs {
		res := &pkgResult{dir: dir}
		hasPkgDoc := false
		hasNonTestFile := false

		for _, f := range pkgDirs[dir] {
			file, err := parser.ParseFile(fset, f, nil, parser.ParseComments)
			if err != nil {
				fmt.Fprintf(os.Stderr, "parse error %s: %v\n", f, err)
				continue
			}
			hasNonTestFile = true
			if file.Doc != nil {
				hasPkgDoc = true
			}

			for _, decl := range file.Decls {
				switch d := decl.(type) {
				case *ast.FuncDecl:
					if !d.Name.IsExported() {
						continue
					}
					res.exported++
					if d.Doc != nil {
						res.documented++
					} else {
						res.missing = append(res.missing, missingSym{fset.Position(d.Pos()), d.Name.Name})
					}

				case *ast.GenDecl:
					for _, spec := range d.Specs {
						switch s := spec.(type) {
						case *ast.TypeSpec:
							if !s.Name.IsExported() {
								continue
							}
							res.exported++
							doc := s.Doc
							if doc == nil && len(d.Specs) == 1 {
								doc = d.Doc
							}
							if doc != nil {
								res.documented++
							} else {
								res.missing = append(res.missing, missingSym{fset.Position(s.Pos()), s.Name.Name})
							}

							if iface, ok := s.Type.(*ast.InterfaceType); ok {
								for _, m := range iface.Methods.List {
									if len(m.Names) == 0 {
										continue // embedded interface
									}
									for _, n := range m.Names {
										if !n.IsExported() {
											continue
										}
										res.ifaceMethods++
										if m.Doc != nil {
											res.ifaceDocumented++
										} else {
											res.missing = append(res.missing, missingSym{fset.Position(m.Pos()), s.Name.Name + "." + n.Name})
										}
									}
								}
							}

						case *ast.ValueSpec:
							for _, n := range s.Names {
								if !n.IsExported() {
									continue
								}
								res.exported++
								doc := s.Doc
								if doc == nil {
									doc = d.Doc
								}
								if doc != nil {
									res.documented++
								} else {
									res.missing = append(res.missing, missingSym{fset.Position(n.Pos()), n.Name})
								}
							}
						}
					}
				}
			}
		}

		if !hasNonTestFile {
			continue
		}
		res.pkgDocMiss = !hasPkgDoc
		results = append(results, res)
		totalExp += res.exported
		totalDoc += res.documented
		totalIfaceExp += res.ifaceMethods
		totalIfaceDoc += res.ifaceDocumented
	}

	missingTotal := 0
	for _, r := range results {
		m := len(r.missing)
		if r.pkgDocMiss {
			m++
		}
		missingTotal += m
		if m == 0 {
			continue
		}
		fmt.Printf("%-45s exported=%-4d documented=%-4d ifaceMethods=%-3d ifaceDocumented=%-3d missing=%-4d pkgDoc=%v\n",
			r.dir, r.exported, r.documented, r.ifaceMethods, r.ifaceDocumented, m, !r.pkgDocMiss)
		if *listFlag {
			for _, ms := range r.missing {
				fmt.Printf("  %s:%d: %s\n", ms.pos.Filename, ms.pos.Line, ms.name)
			}
			if r.pkgDocMiss {
				fmt.Printf("  %s: package comment missing\n", r.dir)
			}
		}
	}

	fmt.Printf("TOTAL exported=%d documented=%d ifaceMethods=%d ifaceDocumented=%d missing=%d\n",
		totalExp, totalDoc, totalIfaceExp, totalIfaceDoc, missingTotal)

	if missingTotal > *maxFlag {
		os.Exit(1)
	}
}
